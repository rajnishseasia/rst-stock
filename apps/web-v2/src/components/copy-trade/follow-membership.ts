export interface FollowMembershipSource {
  targetType?: string;
  targetKey: string;
  membershipKeys?: readonly string[];
}

/** Return every canonical/legacy key that represents one durable follow. */
export function followMembershipKeys(follow: FollowMembershipSource): string[] {
  return [...new Set([follow.targetKey, ...(follow.membershipKeys ?? [])])];
}
