# AI suggestions

## Flow architecture

```
User                    Web                    API                Anthropic            TMDB
 |                       |                      |                    |                   |
 | Tap "Suggest"         |                      |                    |                   |
 |---------------------->|                      |                    |                   |
 |                       | POST /suggestions    |                    |                   |
 |                       | { filters }          |                    |                   |
 |                       |--------------------->|                    |                   |
 |                       |                      | gather context     |                   |
 |                       |                      | (top liked/disliked,                   |
 |                       |                      |  recent, filters)                      |
 |                       |                      |                    |                   |
 |                       |                      | call Claude Haiku  |                   |
 |                       |                      |------------------->|                   |
 |                       |                      |                    | structured JSON   |
 |                       |                      |<-------------------|                   |
 |                       |                      |                                        |
 |                       |                      | for each title:                        |
 |                       |                      |   search TMDB by title+year            |
 |                       |                      |--------------------------------------->|
 |                       |                      |                                        |
 |                       |                      |<---------------------------------------|
 |                       |                      |                                        |
 |                       |                      | save AiSuggestion                      |
 |                       |                      | (filters, prompt, response)            |
 |                       |                      |                                        |
 |                       | { suggestions }      |                                        |
 |                       |<---------------------|                                        |
 | View 5 movie cards    |                                                               |
```

## Context for the LLM

Built from the user's database. The goal is to give the model enough taste signal without overpaying for tokens.

### Context components

1. **Top liked (10 entries)** — user's `WatchedEntry` with `Rating.score >= 8`, sorted by score descending, then `watchedAt` descending. Comments included.
2. **Top disliked (5 entries)** — `Rating.score <= 4`, same idea.
3. **Recent (10 entries)** — last 10 watched regardless of score. Helps the model understand "what the user is currently into."
4. **Wishlist preview (5 entries)** — what's already on the wishlist (so we don't suggest the same movies again).
5. **Already watched** — list of every watched movie's `tmdbId` (ids only, no metadata). Used for post-filtering, not sent to the LLM.
6. **User filters** — `genres`, `countries`, `mood`, `runtime`, `era` (from the request body).
7. **Language** — `User.language` so the model writes descriptions in the right language.

### Context size

Limit is ~3000 input tokens. For Haiku that's pennies ($0.25/MTok input). If a user has fewer than 10 positive ratings — send what they have.

## Prompt

System prompt is fixed; user prompt is dynamic.

```typescript
// packages/api/data-access-ai/src/lib/prompts.ts

export const SYSTEM_PROMPT = `You are a personalized film recommendation engine.

You will be given:
- A user's top-rated films (with their comments)
- A user's poorly-rated films (with their comments)
- The user's recently watched films
- The user's wishlist (films to AVOID suggesting)
- A list of filters (genre, country, mood, runtime, era)
- The user's language for descriptions

Your task: suggest exactly 5 films that the user has NOT seen, are NOT in their wishlist, and that match their filters and taste profile.

Pay close attention to user comments — they often reveal nuanced preferences (e.g. "the plot armor undermined the threat" means they value tension over invincible protagonists).

Return strictly valid JSON in this format:
{
  "suggestions": [
    {
      "title": "Film title in English",
      "originalTitle": "Original title",
      "year": 2023,
      "whyMightLike": "1-2 sentence personalized reasoning in the user's language, referencing their specific taste signals."
    }
  ]
}

Do not include any preamble, markdown formatting, or explanation outside the JSON.`;

export function buildUserPrompt(context: SuggestionContext): string {
  const { topLiked, topDisliked, recent, wishlist, filters, language } = context;

  return JSON.stringify({
    language,
    filters,
    topLiked: topLiked.map((e) => ({
      title: e.movie.title,
      year: e.movie.year,
      score: e.rating.score,
      comment: e.rating.comment,
    })),
    topDisliked: topDisliked.map((e) => ({
      title: e.movie.title,
      year: e.movie.year,
      score: e.rating.score,
      comment: e.rating.comment,
    })),
    recentlyWatched: recent.map((e) => ({ title: e.movie.title, year: e.movie.year })),
    inWishlist: wishlist.map((w) => ({ title: w.movie.title, year: w.movie.year })),
  });
}
```

## Calling Claude

```typescript
// packages/api/data-access-ai/src/lib/anthropic-client.service.ts

import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class AnthropicClient {
  private readonly client: Anthropic;

  constructor(@Inject('ANTHROPIC_API_KEY') apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async suggest(context: SuggestionContext): Promise<RawSuggestionResponse> {
    const message = await this.client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(context) }],
    });

    const textBlock = message.content.find((c) => c.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    const parsed = this.parseJsonStrict(textBlock.text);
    return RawSuggestionResponseSchema.parse(parsed); // Zod validation
  }

  private parseJsonStrict(raw: string): unknown {
    // The model occasionally wraps the response in ```json ... ``` despite the instruction.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error('LLM returned invalid JSON');
    }
  }
}
```

## Resolving against TMDB

For each `{ title, year }` returned by the model:

```typescript
async resolveSuggestions(raw: RawSuggestion[]): Promise<ResolvedSuggestion[]> {
  return Promise.all(
    raw.map(async (suggestion) => {
      const tmdbResults = await this.tmdb.search(suggestion.originalTitle, {
        year: suggestion.year,
        language: 'en-US',
      });
      const best = tmdbResults[0];
      if (!best) return { ...suggestion, tmdbId: null, posterPath: null };

      // Pre-cache the Movie row — the user is likely to add it next
      const movie = await this.moviesService.findOrFetchByTmdbId(best.id);

      return {
        title: movie.title,
        originalTitle: movie.originalTitle,
        year: movie.year,
        whyMightLike: suggestion.whyMightLike,
        tmdbId: movie.tmdbId,
        movieId: movie.id,
        posterPath: movie.posterPath,
      };
    }),
  );
}
```

Parallel `Promise.all` — TMDB doesn't enforce tight rate limits; 5 parallel calls go through fine.

## Saving the `AiSuggestion`

After successful resolution, the whole session is persisted:

```typescript
const aiSuggestion = await this.prisma.aiSuggestion.create({
  data: {
    userId,
    filters: dto.filters,
    promptInput: { system: SYSTEM_PROMPT, user: userPromptText },
    response: { suggestions: resolved },
    resolvedTmdbIds: resolved.map((r) => r.tmdbId).filter(isNotNull),
  },
});
```

Why store this:
- Lets the user see "what was I recommended a month ago" (`/suggest/history`).
- Allows post-hoc analysis of prompts — which signals actually drive good recommendations.
- If the model returned garbage (it happens) — the full input is on disk for debugging.

## Rate limiting

```typescript
// packages/api/feature-suggestions/src/lib/suggestions.controller.ts

@Controller('suggestions')
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class SuggestionsController {
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 req / minute / user
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSuggestionDto) {
    return this.suggestionsService.create(user.id, dto);
  }
}
```

Throttling is keyed on `userId` (not IP), because everything goes through a reverse proxy in production and the IP is shared. A custom `ThrottlerStorage` handles this.

## Errors and graceful degradation

The chain can fail in three places:

1. **Anthropic API unavailable** → return `503 Service Unavailable` with a clear message. The frontend shows "Suggestions service is temporarily unavailable, please try again later."
2. **LLM returned invalid JSON** → retry once with a follow-up message: "Your previous response was not valid JSON. Return only the JSON object." If still invalid — `502 Bad Gateway`.
3. **TMDB couldn't match `title+year`** → return the suggestion without a `tmdbId`/`posterPath`. The UI shows a placeholder poster card and dims the "Add" button.

## Cost

Per Haiku call:
- Input: ~2000 tokens × $0.25/MTok ≈ $0.0005
- Output: ~500 tokens × $1.25/MTok ≈ $0.0006

**Roughly $0.001 per recommendation.** $1 buys 1000 recommendations. Negligible for personal use.

If you want to optimize further:
- Cache results by `hash(filters + topLiked.ids + topDisliked.ids)` for 24 hours — common case is "tap again with the same filters."
- Use Anthropic prompt caching for the system prompt (the static portion is cached on Anthropic's side, lower cost per call).

## Future extensions

- **Mood as an explicit parameter**: "tense", "light", "thoughtful" — appended to the context, the model factors it in.
- **Diversity check**: ensure the 5 suggestions aren't all from one genre/director — retry if they are.
- **Embeddings-based fallback**: if a user has fewer than 5 ratings and the LLM context is thin, use TMDB recommendations by similarity instead.
- **Feedback loop**: after a suggestion, show "rate this recommendation" (👍/👎) — collect data, fold it into the system prompt as few-shot examples.
