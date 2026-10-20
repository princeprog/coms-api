import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../database/db';

export type DispatchDbExecutor = Kysely<DB> | Transaction<DB>;

export type CreateDraftInput = {
  branch_id: string;
  items: Array<{ stock_item_id: string; quantity_dispatched: string }>;
  created_by_user_id: string;
  idempotency_key: string;
};

export type SendDispatchInput = CreateDraftInput & {
  receive_by?: string;
  delivered_by_name: string;
};

export type ScopedActionInput = {
  id: string;
  actor_user_id: string;
  idempotency_key: string;
  branch_ids: string[] | null;
};

export type SendDraftInput = ScopedActionInput & {
  delivered_by_name: string;
  receive_by?: string;
};

export type DispatchItemInput = {
  dispatch_item_id: string;
  quantity: string;
};

export const DISPATCH_RESOLUTION_OUTCOMES = [
  'LOST',
  'NOT_LOADED',
  'SURPLUS',
] as const;
export type DispatchResolutionOutcome =
  (typeof DISPATCH_RESOLUTION_OUTCOMES)[number];

export type ReceiveInput = ScopedActionInput & {
  delivery_date?: string;
  late_reason?: string | null;
  review_case_id?: string;
  reviewer_id?: string;
  items: DispatchItemInput[];
  note: string | null;
};
export type CloseShortageInput = ScopedActionInput & {
  outcome: DispatchResolutionOutcome;
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
