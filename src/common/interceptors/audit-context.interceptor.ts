import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithAuditActor } from '../utils/audit-context';

// Runs after guards, so the authenticated user is known.
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { id?: string } }>();
    const actor =
      typeof request?.user?.id === 'string' ? request.user.id : undefined;
    return new Observable((subscriber) =>
      runWithAuditActor(actor, () => next.handle().subscribe(subscriber)),
    );
  }
}
