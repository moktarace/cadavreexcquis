import { rngFromSeed } from './prng';
import {
  CHARACTERS,
  SITUATIONS,
  TRAITS,
  type Character,
  type Situation,
  type Tag,
  type Trait,
} from './themeData';

/** Toute modification des tables ou de l'algorithme impose une nouvelle version. */
export const THEME_GENERATOR_VERSION = 'v1';

const SITUATION_PROBABILITY = 0.4;

export interface Theme {
  seed: string;
  generatorVersion: string;
  text: string;
  characterId: string;
  traitId: string;
  situationId: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Graine hebdomadaire; toutes les salles d'une même semaine partagent le même thème. */
export function weeklySeed(isoYear: number, isoWeek: number): string {
  return `case-ludique/${isoYear}-W${pad2(isoWeek)}`;
}

function compatible(
  tags: readonly Tag[],
  rule: { requiresAny?: readonly Tag[]; forbids?: readonly Tag[] },
): boolean {
  if (rule.requiresAny && !rule.requiresAny.some((t) => tags.includes(t))) return false;
  if (rule.forbids && rule.forbids.some((t) => tags.includes(t))) return false;
  return true;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function compose(character: Character, trait: Trait, situation: Situation | null): string {
  const article = character.gender === 'm' ? 'un' : 'une';
  const adjective = character.gender === 'm' ? trait.m : trait.f;
  const base = `${article} ${character.noun} ${adjective}`;
  return capitalize(situation ? `${base}, ${situation.text}` : base);
}

export function generateTheme(seed: string, generatorVersion: string = THEME_GENERATOR_VERSION): Theme {
  if (generatorVersion !== 'v1') {
    throw new Error(`Version de générateur inconnue : ${generatorVersion}`);
  }
  const rng = rngFromSeed(`${generatorVersion}|${seed}`);

  // Ordre des tirages figé : personnage, trait, tirage de situation, situation.
  const character = rng.pick(CHARACTERS);
  const trait = rng.pick(TRAITS.filter((t) => compatible(character.tags, t)));
  const wantsSituation = rng.next() < SITUATION_PROBABILITY;
  const situationPool = SITUATIONS.filter((s) => compatible(character.tags, s));
  const situation = wantsSituation ? rng.pick(situationPool) : null;

  return {
    seed,
    generatorVersion,
    text: compose(character, trait, situation),
    characterId: character.id,
    traitId: trait.id,
    situationId: situation?.id ?? null,
  };
}
