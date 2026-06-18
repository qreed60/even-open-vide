export interface TeamProviderCapability {
  value: string;
  label: string;
  status: 'available' | 'unavailable' | 'planned' | 'disabled';
  hint?: string;
  supportsModelOverride?: boolean;
  supportsVision?: boolean;
  supportsLongRunning?: boolean;
}

interface SelectOption {
  value: string;
  label: string;
}

const DEFAULT_ROLES = [
  { value: 'lead', label: 'Lead' },
  { value: 'coordinator', label: 'Coordinator' },
  { value: 'planner', label: 'Planner' },
  { value: 'coder', label: 'Coder' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'scribe', label: 'Scribe' },
  { value: 'tester', label: 'Tester' },
  { value: 'visual_reviewer', label: 'Visual Reviewer' },
  { value: 'visual', label: 'Visual' },
  { value: 'domain_specialist', label: 'Domain Specialist' },
];

const DEFAULT_PROVIDERS: TeamProviderCapability[] = [
  { value: 'claude', label: 'Claude', status: 'available', supportsModelOverride: true, supportsLongRunning: true },
  { value: 'codex', label: 'Codex', status: 'available', supportsModelOverride: true, supportsLongRunning: true },
  { value: 'gemini', label: 'Gemini', status: 'available', supportsModelOverride: true, supportsVision: true },
  { value: 'opencode', label: 'OpenCode', status: 'unavailable', hint: 'enable daemon flag', supportsModelOverride: true, supportsLongRunning: true },
  { value: 'openhands', label: 'OpenHands', status: 'planned', hint: 'planned' },
];

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeStatus(value: unknown): TeamProviderCapability['status'] {
  if (value === 'planned' || value === 'disabled' || value === 'unavailable') return value;
  if (value === false) return 'unavailable';
  return 'available';
}

function booleanField(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const record = metadata as Record<string, unknown>;
  const nested = record.metadata;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return record;
}

export function roleOptionsFromMetadata(metadata: unknown): SelectOption[] {
  const record = metadataRecord(metadata);
  const roles = Array.isArray(record.roles) ? record.roles : undefined;
  if (!roles) return DEFAULT_ROLES;

  const options = roles
    .map((role) => {
      if (typeof role === 'string') return { value: role, label: titleize(role) };
      if (!role || typeof role !== 'object') return null;
      const item = role as Record<string, unknown>;
      const value = typeof item.value === 'string' ? item.value : typeof item.id === 'string' ? item.id : typeof item.role === 'string' ? item.role : '';
      if (!value) return null;
      const label = typeof item.label === 'string' ? item.label : titleize(value);
      return { value, label };
    })
    .filter((option): option is SelectOption => Boolean(option));

  return options.length > 0 ? options : DEFAULT_ROLES;
}

export function providerOptionsFromMetadata(metadata: unknown): TeamProviderCapability[] {
  const record = metadataRecord(metadata);
  const rawProviders = record.providers ?? record.tools;
  const providers: TeamProviderCapability[] = [];

  if (Array.isArray(rawProviders)) {
    for (const provider of rawProviders) {
      if (typeof provider === 'string') {
        const value = provider.toLowerCase();
        providers.push({ value, label: titleize(value), status: value === 'opencode' ? 'disabled' : value === 'openhands' ? 'planned' : 'available' });
        continue;
      }
      if (!provider || typeof provider !== 'object') continue;
      const item = provider as Record<string, unknown>;
      const value = typeof item.value === 'string' ? item.value : typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
      if (!value) continue;
      const normalizedValue = value.toLowerCase();
      const executable = booleanField(item.executable, item.canExecute, item.executionEnabled);
      const enabled = booleanField(item.enabled, item.available);
      const installed = booleanField(item.installed, item.detected, item.present);
      const baseStatus = normalizeStatus(item.status ?? item.available);
      providers.push({
        value: normalizedValue,
        label: typeof item.label === 'string' ? item.label : titleize(normalizedValue),
        status: normalizeProviderStatus(normalizedValue, baseStatus, executable, enabled),
        hint: providerHint(normalizedValue, baseStatus, executable, enabled, installed),
        supportsModelOverride: Boolean(item.supportsModelOverride ?? item.modelOverride),
        supportsVision: Boolean(item.supportsVision ?? item.vision),
        supportsLongRunning: Boolean(item.supportsLongRunning ?? item.supportsStatusPolling ?? item.statusPolling),
      });
    }
  } else if (rawProviders && typeof rawProviders === 'object') {
    for (const [value, provider] of Object.entries(rawProviders as Record<string, unknown>)) {
      const item = provider && typeof provider === 'object' ? provider as Record<string, unknown> : {};
      const normalizedValue = value.toLowerCase();
      const executable = booleanField(item.executable, item.canExecute, item.executionEnabled);
      const enabled = booleanField(item.enabled, item.available, typeof provider === 'boolean' ? provider : undefined);
      const installed = booleanField(item.installed, item.detected, item.present, typeof provider === 'boolean' ? provider : undefined);
      const baseStatus = normalizeStatus(item.status ?? item.available ?? provider);
      providers.push({
        value: normalizedValue,
        label: typeof item.label === 'string' ? item.label : titleize(normalizedValue),
        status: normalizeProviderStatus(normalizedValue, baseStatus, executable, enabled),
        hint: providerHint(normalizedValue, baseStatus, executable, enabled, installed),
        supportsModelOverride: Boolean(item.supportsModelOverride ?? item.modelOverride),
        supportsVision: Boolean(item.supportsVision ?? item.vision),
        supportsLongRunning: Boolean(item.supportsLongRunning ?? item.supportsStatusPolling ?? item.statusPolling),
      });
    }
  }

  const hasMetadata = providers.length > 0;
  const byValue = new Map<string, TeamProviderCapability>();
  for (const provider of (hasMetadata ? providers : DEFAULT_PROVIDERS)) {
    const value = provider.value.toLowerCase();
    byValue.set(value, {
      ...provider,
      value,
      label: value === 'opencode' ? 'OpenCode' : value === 'openhands' ? 'OpenHands' : provider.label,
      status: value === 'openhands' ? 'planned' : provider.status,
      hint: value === 'openhands' ? 'planned' : provider.hint,
    });
  }

  for (const fallback of DEFAULT_PROVIDERS) {
    if (!byValue.has(fallback.value)) {
      byValue.set(fallback.value, { ...fallback, status: hasMetadata ? 'unavailable' : fallback.status });
    }
  }

  return Array.from(byValue.values()).map((provider) => ({
    ...provider,
    label: providerLabel(provider),
  }));
}

function normalizeProviderStatus(
  value: string,
  baseStatus: TeamProviderCapability['status'],
  executable: boolean | undefined,
  enabled: boolean | undefined,
): TeamProviderCapability['status'] {
  if (value === 'openhands') return 'planned';
  if (value !== 'opencode') return baseStatus;
  if (baseStatus === 'disabled' || enabled === false || executable === false) return 'disabled';
  if (baseStatus === 'planned' || baseStatus === 'unavailable') return baseStatus;
  return enabled === true && executable === true ? 'available' : 'disabled';
}

function providerHint(
  value: string,
  baseStatus: TeamProviderCapability['status'],
  executable: boolean | undefined,
  enabled: boolean | undefined,
  installed: boolean | undefined,
): string | undefined {
  if (value === 'openhands') return 'planned';
  if (value !== 'opencode') return undefined;
  if (enabled === true && executable === true) return 'enabled';
  if (installed === true || enabled === false || executable === false) return 'installed, disabled';
  if (baseStatus === 'unavailable') return 'unavailable';
  return 'enable daemon flag';
}

function providerLabel(provider: TeamProviderCapability): string {
  if (provider.status === 'available') return provider.label;
  const hint = provider.hint ?? provider.status;
  return `${provider.label} (${hint})`;
}

export function isProviderSelectable(provider: TeamProviderCapability | undefined): boolean {
  return !provider || provider.status === 'available';
}

export function providerCapabilityHint(provider: TeamProviderCapability | undefined): string {
  if (!provider) return 'available';
  const flags: string[] = [provider.hint ?? provider.status];
  if (provider.supportsModelOverride) flags.push('model override');
  if (provider.supportsVision) flags.push('vision');
  if (provider.supportsLongRunning) flags.push('status polling');
  return flags.join(' · ');
}
