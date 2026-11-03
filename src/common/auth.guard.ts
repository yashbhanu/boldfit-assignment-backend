import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { CUSTOMER_TOKENS } from '../config.js';

type AuthedRequest = Request & { customerId?: string };

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    const customerId = scheme === 'Bearer' ? CUSTOMER_TOKENS[token] : undefined;
    if (!customerId) {
      throw new UnauthorizedException('Missing or invalid bearer token');
    }
    req.customerId = customerId;
    return true;
  }
}

export const CustomerId = createParamDecorator(
  (_: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthedRequest>().customerId!,
);
