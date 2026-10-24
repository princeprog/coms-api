import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceivingRemindersService } from './receiving-reminders.service';
import type { ReceivingRemindersRepository } from './receiving-reminders.repository';

vi.mock('./receiving-reminders.repository', () => ({
  ReceivingRemindersRepository: class {},
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup() {
  const sweep = vi.fn().mockResolvedValue(0);
  const service = new ReceivingRemindersService({
    sweep,
  } as unknown as ReceivingRemindersRepository);
  return { service, sweep };
}

describe('serverless receiving reminders', () => {
  it('runs within the notification request and shares concurrent sweeps', async () => {
    vi.stubEnv('VERCEL', '1');
    const { service, sweep } = setup();
    let finish!: (count: number) => void;
    sweep.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    let completed = false;
    const first = service.refreshOnRequest();
    const second = service.refreshOnRequest().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish(0);
    await Promise.all([first, second]);
    expect(completed).toBe(true);
  });

  it('throttles checks for a minute and retries after a failed sweep', async () => {
    vi.stubEnv('VERCEL', '1');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const { service, sweep } = setup();
    sweep.mockRejectedValueOnce(new Error('Temporary database outage'));
    await expect(service.refreshOnRequest()).resolves.toBeUndefined();
    clock.mockReturnValue(159_999);
    await service.refreshOnRequest();
    expect(sweep).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(160_000);
    await service.refreshOnRequest();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('does not create a background timer on Vercel', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '1');
    const timer = vi.spyOn(globalThis, 'setInterval');
    const { service, sweep } = setup();
    service.onModuleInit();
    expect(timer).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('leaves reminder scheduling to the existing timer outside Vercel', async () => {
    vi.stubEnv('VERCEL', '');
    const { service, sweep } = setup();
    await service.refreshOnRequest();
    expect(sweep).not.toHaveBeenCalled();
  });
});
