import type { GlassScreen } from 'even-toolkit/glass-screen-router';
import { line } from 'even-toolkit/types';
import { compactHeader } from '../header';
import { truncate, applyScrollIndicators } from 'even-toolkit/text-utils';
import { fieldJoin, SEP } from 'even-toolkit/glass-format';
import type { OpenVideSnapshot, OpenVideActions } from '../types';

function routeLabel(route: unknown): string {
  if (!Array.isArray(route) || route.length === 0) return '';
  return route.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return 'member';
    const record = item as { role?: string; member?: string; name?: string };
    return record.role || record.member || record.name || 'member';
  }).join('>');
}

export const teamChatScreen: GlassScreen<OpenVideSnapshot, OpenVideActions> = {
  display: (snap, nav) => {
    const team = snap.teams.find(t => t.id === snap.selectedTeamId);
    const teamName = team?.name ?? 'Team';
    const headerLines = compactHeader(fieldJoin(teamName.toUpperCase(), 'Chat'));

    if (snap.teamMessages.length === 0) {
      return { lines: [...headerLines, line('No messages', 'meta')] };
    }

    const contentLines: string[] = [];
    for (const msg of snap.teamMessages) {
      const sender = truncate(msg.from, 8);
      const orchestration = msg.orchestration;
      const route = routeLabel(orchestration?.route);
      const status = orchestration?.status ? truncate(orchestration.status.toUpperCase(), 8) : '';
      const prefix = route || status ? fieldJoin(sender, route || status) : sender;
      contentLines.push(`${prefix} ${SEP} ${truncate(msg.text, 32)}`);
    }

    // Scroll from bottom
    const contentSlots = 8; // 10 - 2 (title + separator)
    const maxFromBottom = Math.max(0, contentLines.length - contentSlots);
    const clampedOffset = Math.min(nav.highlightedIndex, maxFromBottom);
    const start = Math.max(0, contentLines.length - contentSlots - clampedOffset);
    const visible = contentLines.slice(start, start + contentSlots);
    const displayLines = visible.map(t => line(t, 'normal'));
    applyScrollIndicators(displayLines, start, contentLines.length, contentSlots, t => line(t, 'meta'));

    return { lines: [...headerLines, ...displayLines] };
  },

  action: (action, nav, _snap, ctx) => {
    if (action.type === 'HIGHLIGHT_MOVE') {
      const idx = action.direction === 'down'
        ? nav.highlightedIndex + 1
        : Math.max(nav.highlightedIndex - 1, 0);
      return { ...nav, highlightedIndex: idx };
    }
    if (action.type === 'GO_BACK') {
      ctx.navigate('/teams');
      return { ...nav, highlightedIndex: 0 };
    }
    return nav;
  },
};
