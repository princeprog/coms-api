export const notificationKinds = [
  'DISPATCH_COUNT_REMINDER',
  'DISPATCH_SENT',
  'DISPATCH_DISCREPANCY',
  'DISPATCH_RESOLVED',
  'REPORT_SUBMITTED',
  'REPORT_RETURNED',
  'REPORT_APPROVED',
  'DISPATCH_OVERDUE',
  'DISPATCH_LATE_COUNT',
  'SHIFT_NEEDS_REVIEW',
  'DISPATCH_RECEIVED',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notificationPolicy: Record<
  NotificationKind,
  {
    module: 'dispatches' | 'daily_reports' | 'shifts';
    actions: string[];
    review: boolean;
  }
> = {
  DISPATCH_COUNT_REMINDER: {
    module: 'dispatches',
    actions: ['receive'],
    review: false,
  },
  SHIFT_NEEDS_REVIEW: { module: 'shifts', actions: ['review'], review: true },
  DISPATCH_OVERDUE: {
    module: 'dispatches',
    actions: ['receive', 'shortage_close'],
    review: false,
  },
  DISPATCH_LATE_COUNT: {
    module: 'dispatches',
    actions: ['shortage_close'],
    review: false,
  },
  DISPATCH_SENT: { module: 'dispatches', actions: ['receive'], review: false },
  // Clean counts go to the sending team and Super Admin, who usually sends.
  DISPATCH_RECEIVED: {
    module: 'dispatches',
    actions: ['dispatch'],
    review: true,
  },
  DISPATCH_DISCREPANCY: {
    module: 'dispatches',
    actions: ['shortage_close'],
    review: true,
  },
  DISPATCH_RESOLVED: {
    module: 'dispatches',
    actions: ['receive'],
    review: false,
  },
  REPORT_SUBMITTED: {
    module: 'daily_reports',
    actions: ['approve', 'return'],
    review: true,
  },
  REPORT_RETURNED: {
    module: 'daily_reports',
    actions: ['update', 'submit'],
    review: false,
  },
  REPORT_APPROVED: {
    module: 'daily_reports',
    actions: ['update', 'submit'],
    review: false,
  },
};
