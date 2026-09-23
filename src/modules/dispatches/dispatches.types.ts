import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../database/db';

export type DispatchDbExecutor = Kysely<DB> | Transaction<DB>;

export type CreateDraftInput = {
  stock_request_id: string;
  created_by_user_id: string;
  idempotency_key: string;
};

export type ScopedActionInput = {
  id: string;
  actor_user_id: string;
  idempotency_key: string;
  branch_ids: string[] | null;
};

export type DispatchItemInput = {
  dispatch_item_id: string;
  quantity: string;
};

export type ReceiveInput = ScopedActionInput & { items: DispatchItemInput[] };
export type CloseShortageInput = ScopedActionInput & {
  reason: string;
  items: DispatchItemInput[];
};

export type DispatchEvent = {
  dispatch_id: string;
  event_type: string;
  actor_user_id: string;
  dispatch_receipt_id: string | null;
  shortage_closure_id: string | null;
};

export type DispatchStatus =
  | 'DRAFT'
  | 'IN_TRANSIT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED_WITH_SHORTAGE';
