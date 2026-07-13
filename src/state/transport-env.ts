import { dirname } from 'node:path';
import {
  stateAuthorityTransportCapabilityForChild,
  type ResolvedStateAuthorityContext,
} from './authority.js';

export const OMX_STATE_AUTHORITY_PATH_ENV = 'OMX_STATE_AUTHORITY_PATH';
export const OMX_STATE_AUTHORITY_ID_ENV = 'OMX_STATE_AUTHORITY_ID';
export const OMX_STATE_AUTHORITY_GENERATION_ID_ENV =
  'OMX_STATE_AUTHORITY_GENERATION_ID';
export const OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV =
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST';
export const OMX_STATE_AUTHORITY_CAPABILITY_ENV =
  'OMX_STATE_AUTHORITY_CAPABILITY';

export function buildStateAuthorityTransportEnv(
  authority: Readonly<ResolvedStateAuthorityContext>,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OMX_STARTUP_CWD: authority.workspace_identity.canonical_path,
    OMX_ROOT: dirname(authority.generation.canonical_omx_root),
    OMX_STATE_ROOT: dirname(authority.generation.canonical_omx_root),
    OMX_TEAM_STATE_ROOT: authority.canonical_state_root,
    [OMX_STATE_AUTHORITY_PATH_ENV]: authority.authority_path,
    [OMX_STATE_AUTHORITY_ID_ENV]: authority.generation.authority_id,
    [OMX_STATE_AUTHORITY_GENERATION_ID_ENV]: authority.generation.generation_id,
    [OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV]:
      authority.workspace_identity.digest,
    [OMX_STATE_AUTHORITY_CAPABILITY_ENV]:
      stateAuthorityTransportCapabilityForChild(authority),
  };
}
