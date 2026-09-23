import { Injectable } from '@nestjs/common';
import { AccessControlRepository } from './access-control.repository';

@Injectable()
export class AccessControlService {
  constructor(private readonly repository: AccessControlRepository) {}

  findAccessContext(userId: string) {
    return this.repository.findAccessContext(userId);
  }
}
