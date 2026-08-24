export interface ProvisionCommitBoundary {
  <T>(commit: (committedAt: Date) => T): T;
}
