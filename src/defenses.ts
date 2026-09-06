import type { GameState, Policy, RouteId, ThreatType } from './types';
import { ROUTES, ROUTE_NAMES } from './types.ts';

export type DefenseMode = 'open' | 'auth' | 'rate' | 'isolate';
export const DEFENSES: { id: DefenseMode; label: string; cost: number; icon: string; policy: Policy }[] = [
  { id: 'open', label: 'Open', cost: 0, icon: 'flow', policy: { auth: false, rate: 0, isolated: false } },
  { id: 'auth', label: 'Key check', cost: 15, icon: 'lock', policy: { auth: true, rate: 0, isolated: false } },
  { id: 'rate', label: 'Slow flow', cost: 10, icon: 'rate', policy: { auth: false, rate: 1, isolated: false } },
  { id: 'isolate', label: 'Close bridge', cost: 5, icon: 'isolate', policy: { auth: false, rate: 0, isolated: true } },
];

export const policyForMode = (mode: DefenseMode): Policy => ({ ...DEFENSES.find(defense => defense.id === mode)!.policy });
export const policyCost = (policy: Policy) => Number(policy.auth) * 15 + Number(policy.rate > 0) * 10 + Number(policy.isolated) * 5;
export function modeForPolicy(policy: Policy): DefenseMode | 'custom' {
  return DEFENSES.find(defense => defense.policy.auth === policy.auth && defense.policy.rate === policy.rate && defense.policy.isolated === policy.isolated)?.id ?? 'custom';
}
export function canSetMode(mode: DefenseMode, policy: Policy, credits: number) {
  return DEFENSES.find(defense => defense.id === mode)!.cost <= credits + policyCost(policy);
}

export const THREAT_INFO: Record<ThreatType, { title: string; name: string; mode: DefenseMode; detail: string }> = {
  'bad-login': { title: 'Suspicious logins detected', name: 'Coral probes', mode: 'auth', detail: 'Invalid keys. Key check refuses these probes.' },
  swarm: { title: 'Request swarm detected', name: 'Amber swarm', mode: 'rate', detail: 'Slow flow admits only one per second. Most of the swarm stays outside.' },
  breach: { title: 'Breach carriers approaching', name: 'Violet carriers', mode: 'isolate', detail: 'Heavy hits from valid keys. Close the bridge to stop every carrier.' },
};
export type FlightSignal = { title: string; detail: string; route: RouteId; mode: DefenseMode; kind: 'calm' | ThreatType; name: string };
export function signalsForState(state: Pick<GameState, 'wave'> & Partial<Pick<GameState, 'incoming'>>): FlightSignal[] {
  return ROUTES.map(route => {
    const threat = state.wave.threats?.find(item => item.route === route)
      ?? state.incoming?.find(item => item.route === route && item.role === 'hostile' && item.threatType);
    if (threat?.threatType) return { ...THREAT_INFO[threat.threatType], route, kind: threat.threatType };
    return { title: `${ROUTE_NAMES[route]} is all clear`, detail: 'Open the gate to welcome every customer.', route, mode: 'open', kind: 'calm', name: 'All clear' };
  });
}
