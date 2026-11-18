export type Gender = 'm' | 'f';

/** Étiquettes servant uniquement à écarter les combinaisons incohérentes. */
export type Tag = 'human' | 'job' | 'monster' | 'animal' | 'machine' | 'spirit' | 'creature' | 'magic';

export interface Character {
  id: string;
  noun: string;
  gender: Gender;
  tags: readonly Tag[];
}

export interface Trait {
  id: string;
  m: string;
  f: string;
  /** Le personnage doit avoir au moins une de ces étiquettes. */
  requiresAny?: readonly Tag[];
  /** Le personnage ne doit avoir aucune de ces étiquettes. */
  forbids?: readonly Tag[];
}

export interface Situation {
  id: string;
  text: string;
  requiresAny?: readonly Tag[];
  forbids?: readonly Tag[];
}

export const CHARACTERS: readonly Character[] = [
  { id: 'pompier', noun: 'pompier', gender: 'm', tags: ['human', 'job'] },
  { id: 'vampire', noun: 'vampire', gender: 'm', tags: ['monster'] },
  { id: 'detective', noun: 'détective', gender: 'm', tags: ['human', 'job'] },
  { id: 'astronaute', noun: 'astronaute', gender: 'm', tags: ['human', 'job'] },
  { id: 'pirate', noun: 'pirate', gender: 'm', tags: ['human'] },
  { id: 'boulanger', noun: 'boulanger', gender: 'm', tags: ['human', 'job'] },
  { id: 'robot', noun: 'robot', gender: 'm', tags: ['machine'] },
  { id: 'fantome', noun: 'fantôme', gender: 'm', tags: ['spirit'] },
  { id: 'dragon', noun: 'dragon', gender: 'm', tags: ['creature', 'magic'] },
  { id: 'chevalier', noun: 'chevalier', gender: 'm', tags: ['human'] },
  { id: 'facteur', noun: 'facteur', gender: 'm', tags: ['human', 'job'] },
  { id: 'magicien', noun: 'magicien', gender: 'm', tags: ['human', 'job', 'magic'] },
  { id: 'dinosaure', noun: 'dinosaure', gender: 'm', tags: ['animal', 'creature'] },
  { id: 'chat', noun: 'chat', gender: 'm', tags: ['animal'] },
  { id: 'cuisinier', noun: 'cuisinier', gender: 'm', tags: ['human', 'job'] },
  { id: 'clown', noun: 'clown', gender: 'm', tags: ['human', 'job'] },
  { id: 'loup-garou', noun: 'loup-garou', gender: 'm', tags: ['monster', 'creature'] },
  { id: 'cowboy', noun: 'cowboy', gender: 'm', tags: ['human'] },
  { id: 'extraterrestre', noun: 'extraterrestre', gender: 'm', tags: ['creature'] },
  { id: 'sorciere', noun: 'sorcière', gender: 'f', tags: ['human', 'magic'] },
  { id: 'fee', noun: 'fée', gender: 'f', tags: ['creature', 'magic'] },
  { id: 'exploratrice', noun: 'exploratrice', gender: 'f', tags: ['human', 'job'] },
  { id: 'reine', noun: 'reine', gender: 'f', tags: ['human'] },
  { id: 'pilote', noun: 'pilote', gender: 'f', tags: ['human', 'job'] },
  { id: 'bibliothecaire', noun: 'bibliothécaire', gender: 'f', tags: ['human', 'job'] },
  { id: 'sirene', noun: 'sirène', gender: 'f', tags: ['creature', 'magic'] },
  { id: 'grenouille', noun: 'grenouille', gender: 'f', tags: ['animal'] },
  { id: 'mamie', noun: 'mamie', gender: 'f', tags: ['human'] },
  { id: 'princesse', noun: 'princesse', gender: 'f', tags: ['human'] },
  { id: 'momie', noun: 'momie', gender: 'f', tags: ['monster', 'spirit'] },
];

export const TRAITS: readonly Trait[] = [
  { id: 'amoureux', m: 'amoureux', f: 'amoureuse' },
  { id: 'vegetarien', m: 'végétarien', f: 'végétarienne', forbids: ['machine', 'spirit'] },
  { id: 'malchanceux', m: 'malchanceux', f: 'malchanceuse' },
  { id: 'hypocondriaque', m: 'hypocondriaque', f: 'hypocondriaque', forbids: ['machine'] },
  { id: 'timide', m: 'timide', f: 'timide' },
  { id: 'maladroit', m: 'maladroit', f: 'maladroite' },
  { id: 'distrait', m: 'distrait', f: 'distraite' },
  { id: 'jaloux', m: 'jaloux', f: 'jalouse' },
  { id: 'insomniaque', m: 'insomniaque', f: 'insomniaque', forbids: ['machine'] },
  { id: 'fauche', m: 'fauché', f: 'fauchée', forbids: ['spirit'] },
  { id: 'trop-poli', m: 'trop poli', f: 'trop polie' },
  { id: 'paresseux', m: 'paresseux', f: 'paresseuse' },
  { id: 'gourmand', m: 'gourmand', f: 'gourmande', forbids: ['machine'] },
  { id: 'peureux', m: 'peureux', f: 'peureuse' },
  { id: 'curieux', m: 'curieux', f: 'curieuse' },
  { id: 'enrhume', m: 'enrhumé', f: 'enrhumée', forbids: ['machine', 'spirit'] },
  { id: 'perdu', m: 'perdu', f: 'perdue' },
  { id: 'bavard', m: 'bavard', f: 'bavarde' },
  { id: 'ponctuel', m: 'ponctuel', f: 'ponctuelle' },
  { id: 'sentimental', m: 'sentimental', f: 'sentimentale' },
  { id: 'farceur', m: 'farceur', f: 'farceuse' },
  { id: 'nostalgique', m: 'nostalgique', f: 'nostalgique' },
  { id: 'reveur', m: 'rêveur', f: 'rêveuse' },
  { id: 'grincheux', m: 'grincheux', f: 'grincheuse' },
  { id: 'fatigue', m: 'fatigué', f: 'fatiguée', forbids: ['machine'] },
  { id: 'superstitieux', m: 'superstitieux', f: 'superstitieuse' },
  { id: 'allergique', m: 'allergique à la poussière', f: 'allergique à la poussière', forbids: ['machine', 'spirit'] },
  { id: 'en-retard', m: 'toujours en retard', f: 'toujours en retard' },
  { id: 'surdoue', m: 'surdoué', f: 'surdouée', requiresAny: ['human', 'machine', 'creature'] },
  { id: 'sans-memoire', m: 'qui perd la mémoire', f: 'qui perd la mémoire' },
];

/** Locutions neutres en genre, ajoutées après une virgule. */
export const SITUATIONS: readonly Situation[] = [
  { id: 'rentree', text: 'le jour de la rentrée' },
  { id: 'panne', text: 'pendant une panne de courant' },
  { id: 'veille-depart', text: "la veille d'un grand départ" },
  { id: 'tempete', text: 'un jour de tempête' },
  { id: 'fete-foraine', text: 'à la fête foraine' },
  { id: 'marche', text: 'au milieu du marché' },
  { id: 'demenagement', text: 'pendant un déménagement' },
  { id: 'gouter', text: "à l'heure du goûter" },
  { id: 'train-nuit', text: 'dans un train de nuit' },
  { id: 'ile', text: 'sur une île minuscule' },
  { id: 'lac-gele', text: "au bord d'un lac gelé" },
  { id: 'brouillard', text: 'un matin de brouillard' },
  { id: 'bibliotheque', text: 'dans une bibliothèque endormie' },
  { id: 'pause', text: 'pendant la pause déjeuner', requiresAny: ['job'] },
  { id: 'pleine-lune', text: 'la nuit de la pleine lune', requiresAny: ['monster', 'magic', 'creature'] },
  { id: 'soldes', text: 'le premier jour des soldes', forbids: ['spirit'] },
];
