export interface TeamProviderCapability {
  value: string;
  label: string;
  status: 'available' | 'unavailable' | 'planned' | 'disabled';
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
        providers.push({ value: provider, label: titleize(provider), status: 'available' });
        continue;
      }
      if (!provider || typeof provider !== 'object') continue;
      const item = provider as Record<string, unknown>;
      const value = typeof item.value === 'string' ? item.value : typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
      if (!value) continue;
      providers.push({
        value,
        label: typeof item.label === 'string' ? item.label : titleize(value),
        status: normalizeStatus(item.status ?? item.available),
        supportsModelOverride: Boolean(item.supportsModelOverride ?? item.modelOverride),
        supportsVision: Boolean(item.supportsVision ?? item.vision),
        supportsLongRunning: Boolean(item.supportsLongRunning ?? item.supportsStatusPolling ?? item.statusPolling),
      });
    }
  } else if (rawProviders && typeof rawProviders === 'object') {
    for (const [value, provider] of Object.entries(rawProviders as Record<string, unknown>)) {
      const item = provider && typeof provider === 'object' ? provider as Record<string, unknown> : {};
      providers.push({
        value,
        label: typeof item.label === 'string' ? item.label : titleize(value),
        status: normalizeStatus(item.status ?? item.available ?? provider),
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
    if ((value === 'opencode' || value === 'openhands') && provider.status === 'available') {
      byValue.set(value, { ...provider, value, status: 'planned' });
    } else {
      byValue.set(value, { ...provider, value });
    }
  }

  for (const fallback of DEFAULT_PROVIDERS) {
    if (!byValue.has(fallback.value)) {
      byValue.set(fallback.value, { ...fallback, status: hasMetadata ? 'unavailable' : fallback.status });
    }
  }

  return Array.from(byValue.values()).map((provider) => ({
    ...provider,
    label: provider.status === 'available' ? provider.label : `${provider.label} (${provider.status})`,
  }));
}

export function isProviderSelectable(provider: TeamProviderCapability | undefined): boolean {
  return !provider || provider.status === 'available';
}

export function providerCapabilityHint(provider: TeamProviderCapability | undefined): string {
  if (!provider) return 'available';
  const flags: string[] = [provider.status];
  if (provider.supportsModelOverride) flags.push('model override');
  if (provider.supportsVision) flags.push('vision');
  if (provider.supportsLongRunning) flags.push('status polling');
  return flags.join(' · ');
}
