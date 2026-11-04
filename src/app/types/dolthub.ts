/** DoltHub provisioning types. Sourced from lib/DoltHubProvisioningService.js. */

export interface DoltHubProvisioningResult {
  success: boolean;
  databaseName: string;
  databaseUrl: string;
  remoteUrl?: string;
  owner: string;
  repo?: string;
  error?: string;
  alreadyExists?: boolean;
  pushCompleted?: boolean;
  pushError?: string;
  status?: string;
  dry_run?: boolean;
  project_identifier?: string;
  remote_name?: string;
  remote_url?: string;
  visibility?: string;
  database_created?: boolean;
  database_already_exists?: boolean;
  remote_changed?: boolean;
  pushed?: boolean;
  commands?: string[];
}

export interface DoltHubDatabase {
  name: string;
  owner: string;
  visibility: 'public' | 'private';
  created_at?: string;
}

export interface DoltHubProvisioningConfig {
  enabled: boolean;
  dryRun: boolean;
  apiUrl: string;
  apiToken?: string;
  owner: string;
  defaultVisibility: 'public' | 'private';
  remoteName: string;
}
