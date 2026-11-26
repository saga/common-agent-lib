export type DreamingRole = 'owner' | 'admin' | 'reviewer' | 'writer' | 'reader';
export type DreamingAction =
  | 'experience:append' | 'memory:read' | 'memory:write'
  | 'review:read' | 'review:resolve' | 'feedback:write' | 'run:trigger';

export interface DreamingActor {
  /** Stable subject ID supplied by an authenticated identity provider. */
  subject: string;
  /** Informational identity-provider claims; these never grant permissions by themselves. */
  roles?: readonly DreamingRole[];
}

export interface DreamingAuthorizationRequest {
  actor: DreamingActor;
  scope: string;
  action: DreamingAction;
  resourceId?: string;
}

export interface DreamingAuthorizationPolicy {
  authorize(request: DreamingAuthorizationRequest): boolean | Promise<boolean>;
}

const roleActions: Record<DreamingRole, ReadonlySet<DreamingAction>> = {
  owner: new Set(['experience:append', 'memory:read', 'memory:write', 'review:read', 'review:resolve', 'feedback:write', 'run:trigger']),
  admin: new Set(['experience:append', 'memory:read', 'memory:write', 'review:read', 'review:resolve', 'feedback:write', 'run:trigger']),
  reviewer: new Set(['memory:read', 'review:read', 'review:resolve']),
  writer: new Set(['experience:append', 'memory:read', 'feedback:write', 'run:trigger']),
  reader: new Set(['memory:read', 'review:read']),
};

/** Default-deny role policy. Authentication and role assignment remain explicit inputs. */
export class RoleBasedDreamingAuthorization implements DreamingAuthorizationPolicy {
  private readonly grants: ReadonlyMap<string, ReadonlyMap<string, readonly DreamingRole[]>>;

  constructor(grants: Readonly<Record<string, Readonly<Record<string, readonly DreamingRole[]>>>>) {
    this.grants = new Map(Object.entries(grants).map(([subject, scopes]) =>
      [subject, new Map(Object.entries(scopes))]));
  }

  authorize(request: DreamingAuthorizationRequest): boolean {
    if (!request.actor.subject.trim() || !request.scope.trim()) return false;
    const configuredRoles = this.grants.get(request.actor.subject)?.get(request.scope);
    if (!configuredRoles?.length) return false;
    return configuredRoles.some((role) => roleActions[role]?.has(request.action) === true);
  }
}

/** Use this when the application deliberately disables all privileged operations. */
export class DenyAllDreamingAuthorization implements DreamingAuthorizationPolicy {
  authorize(): false { return false; }
}

export async function assertDreamingAuthorized(
  policy: DreamingAuthorizationPolicy,
  request: DreamingAuthorizationRequest,
): Promise<void> {
  if (!await policy.authorize(request)) {
    throw new Error(`Not authorized for ${request.action} in scope ${request.scope}.`);
  }
}
