import { AppService } from './app.service';

describe('AppService', () => {
  it('returns the API hello message', () => {
    expect(new AppService().getData()).toEqual({ message: 'Hello API' });
  });
});
