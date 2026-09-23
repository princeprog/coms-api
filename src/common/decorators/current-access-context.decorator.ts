import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessContext } from '../../modules/access-control/access-control.types';

type RequestWithAccessContext = { accessContext: AccessContext };

export const CurrentAccessContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<RequestWithAccessContext>().accessContext,
);
