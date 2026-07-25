import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

import { RouteComputeStatsService } from './route-compute-stats.service';

/**
 * Wraps POST /api/routes/compute to time the whole request and persist one telemetry row.
 *
 * It opens an AsyncLocalStorage scope holding a shared draft, so RoutingService can record the
 * compute facts into the same object during the handler; on completion it stamps handlingMs and
 * fires the (best-effort, non-awaited) persist. Nothing here can slow or fail the response: the
 * value flows straight through and persistence is deferred and swallowed on error.
 */
@Injectable()
export class RouteComputeTimingInterceptor implements NestInterceptor {
  constructor(private readonly stats: RouteComputeStatsService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const draft = this.stats.createDraft();
    const start = Date.now();

    return new Observable((subscriber) => {
      this.stats.als.run(draft, () => {
        const finish = (): void => {
          draft.handlingMs = Date.now() - start;
          void this.stats.persist(draft);
        };
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => {
            finish();
            subscriber.error(error);
          },
          complete: () => {
            finish();
            subscriber.complete();
          },
        });
      });
    });
  }
}
