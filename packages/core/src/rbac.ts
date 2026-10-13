/**
 * Role-based access control. Roles expand to permission strings here, in code,
 * so permission changes are code-reviewed (docs/security.md §3).
 */

export const ROLES = ['owner', 'admin', 'manager', 'rep'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'calls.place',
  'calls.read.own',
  'calls.read.org',
  'calls.disposition',
  /** Hold, add call, merge, transfer on a live call (conference control). */
  'calls.control',
  /** Listen, whisper or barge into a teammate's live call (supervision). */
  'calls.monitor',
  'leads.read',
  'leads.assign',
  'recordings.listen.own',
  'recordings.listen.org',
  'reports.view.own',
  'reports.view.org',
  'numbers.manage',
  'dispositions.manage',
  'suppression.manage',
  'admin.users',
  'admin.integrations',
  'admin.events',
  // SMS (Phase 4)
  'messages.send',
  'messages.read.own',
  'messages.read.org',
  'messages.templates.manage',
  // Reporting (Phase 6)
  'floor.view',
  // Workflows + tasks (Phase 7)
  'workflows.manage',
  'tasks.read.own',
  'tasks.read.org',
  'tasks.write',
  // Dialers (Phase 5)
  'campaigns.manage',
  'campaigns.run',
  // Contacts (docs/contacts.md)
  'contacts.read',
  'contacts.write',
  'contacts.delete',
  'contacts.import',
  'contacts.export',
  // In-call scripts (docs/scripts.md)
  'scripts.read',
  'scripts.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const REP: Permission[] = [
  'calls.place',
  'calls.read.own',
  'calls.disposition',
  'calls.control',
  'leads.read',
  'recordings.listen.own',
  'reports.view.own',
  'messages.send',
  'messages.read.own',
  'tasks.read.own',
  'tasks.write',
  'campaigns.run',
  'contacts.read',
  'contacts.write',
  'scripts.read',
];

const MANAGER: Permission[] = [
  ...REP,
  'calls.read.org',
  'calls.monitor',
  'leads.assign',
  'recordings.listen.org',
  'reports.view.org',
  'messages.read.org',
  // A manager owns the org's message templates the same way they own its
  // scripts (`scripts.write`): the person who coaches the reps is the person
  // who fixes the wording, and an admin round-trip for a typo is why reps
  // paste raw text into the composer instead.
  'messages.templates.manage',
  'floor.view',
  'workflows.manage',
  'tasks.read.org',
  'campaigns.manage',
  'contacts.delete',
  'contacts.import',
  'contacts.export',
  'scripts.write',
];

const ADMIN: Permission[] = [
  ...MANAGER,
  'numbers.manage',
  'dispositions.manage',
  'suppression.manage',
  'admin.users',
  'admin.integrations',
  'admin.events',
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  rep: new Set(REP),
  manager: new Set(MANAGER),
  admin: new Set(ADMIN),
  owner: new Set(ADMIN), // owner == admin + billing (billing arrives later)
};

export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
