import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../database/db';

export type ExpenseExecutor = Kysely<DB> | Transaction<DB>;
export type ExpenseSource =
  'OPERATING' | 'SUPPLIER_DELIVERY' | 'DIRECT_PURCHASE';
export type ExpenseLocation = {
  scope: 'COMMISSARY' | 'BRANCH';
  branch_id: string | null;
};
export type ExpenseAccess = { commissary: boolean; branchIds: string[] | null };
export type ExpenseInput = ExpenseLocation & {
  expense_date: string;
  category_id: string;
  description: string;
  amount: string;
  payment_method: 'CASH' | 'BANK_TRANSFER' | 'EWALLET' | 'CARD' | 'OTHER';
  cash_source: 'REGISTER' | 'OTHER' | null;
  cash_movement_id: string | null;
  payee: string | null;
  reference: string | null;
  notes: string | null;
};
export type ExpenseRecord = ExpenseLocation & {
  id: string;
  source: ExpenseSource;
  expense_date: string;
  location_name: string;
  category_id: string;
  category_name: string;
  description: string;
  amount: string;
  payment_method: ExpenseInput['payment_method'] | null;
  cash_source: ExpenseInput['cash_source'];
  cash_movement_id: string | null;
  payee: string | null;
  reference: string | null;
  notes: string | null;
  status: 'RECORDED' | 'VOIDED';
  revision: number;
  created_by_user_id: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
};
export type ExpenseEvent = {
  id: string;
  action: 'CREATED' | 'UPDATED' | 'VOIDED';
  reason: string | null;
  actor_name: string;
  created_at: string;
  before: ExpenseRecord | null;
  after: ExpenseRecord;
};
export type ExpenseDetail = {
  record: ExpenseRecord;
  history: ExpenseEvent[];
  source_href: string | null;
};
export type ExpenseCategory = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};
export type ExpenseBreakdown = { id: string; name: string; amount: string };
export type ExpensePage = {
  items: ExpenseRecord[];
  total: number;
  page: number;
  page_size: number;
  summary: {
    recorded_spending: string;
    operating_expenses: string;
    stock_purchases: string;
  };
  by_location: ExpenseBreakdown[];
  by_category: ExpenseBreakdown[];
};
