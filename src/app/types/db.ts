/** Row shape of the `projects` registry table (see database/migrations.ts). */
export interface ProjectRow {
  identifier: string;
  name: string;
  filesystem_path: string | null;
  git_url: string | null;
  status: string;
  tech_stack: string | null;
  last_scan_at: number | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
  letta_agent_id: string | null;
  letta_base_url: string | null;
  provider_kind: string | null;
  pack_dir: string | null;
  storage_dir: string | null;
  beads_prefix: string | null;
  beads_remote_owner: string | null;
  beads_remote_repo: string | null;
  beads_remote_url: string | null;
  beads_remote_name: string | null;
  beads_remote_status: string | null;
  beads_remote_visibility: string | null;
  beads_remote_provisioned_at: number | null;
  beads_remote_last_push_at: number | null;
  beads_remote_last_error: string | null;
}
