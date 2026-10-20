export const notificationKinds = [
  'DISPATCH_SENT',
  'DISPATCH_DISCREPANCY',
  'DISPATCH_RESOLVED',
  'REPORT_SUBMITTED',
  'REPORT_RETURNED',
  'REPORT_APPROVED',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notificationPolicy: Record<
  NotificationKind,
  {
    module: 'dispatches' | 'daily_reports';
    actions: string[];
    review: boolean;
  }
> = {
  DISPATCH_SENT: { module: 'dispatches', actions: ['receive'], review: false },
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
