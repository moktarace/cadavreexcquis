import { describe, expect, it } from 'vitest';
import { bornFromYourDrawing, distinctAuthors, groupRewardEvents, hasRewardNews, inspiredMessage, openableStories, storiesDoneMessage, unlockQueue, withoutSeen, type RewardEvent } from './rewards';

const ev = (id: string, kind: RewardEvent['kind'], extra: Partial<RewardEvent> = {}): RewardEvent => ({
  id, kind, endId: kind === 'story_done' ? `end-${id}` : null, rootId: null, ref: null, n: null, expired: false, createdAt: 0, seen: false, ...extra,
});

describe('regroupement des nouveautés', () => {
  const events = [ev('1', 'story_done'), ev('2', 'story_done'), ev('3', 'inspired', { n: 3 }), ev('4', 'sticker', { ref: 'mustache' }), ev('5', 'sticker', { ref: 'glasses' }), ev('6', 'sticker', { ref: 'inconnu' })];

  it('range chaque nouveauté dans sa catégorie et ignore un tampon inconnu', () => {
    const news = groupRewardEvents(events);
    expect(news.stories).toHaveLength(2);
    expect(news.inspired).toHaveLength(1);
    expect(news.stickers.map((s) => s.def.id)).toEqual(['mustache', 'glasses']);
    expect(hasRewardNews(groupRewardEvents([]))).toBe(false);
  });

  it('présente tous les tampons débloqués ensemble, sans succession d’animations', () => {
    expect(unlockQueue(groupRewardEvents(events)).map((d) => d.id)).toEqual(['mustache', 'glasses']);
  });

  it('une histoire dont les dessins ont disparu ne s’ouvre plus', () => {
    expect(openableStories([ev('1', 'story_done'), ev('2', 'story_done', { expired: true })]).map((e) => e.id)).toEqual(['1']);
  });

  it('ne rejoue pas une nouveauté déjà découverte', () => {
    expect(withoutSeen([ev('1', 'story_done'), ev('2', 'story_done', { seen: true }), ev('3', 'story_done')], new Set(['3'])).map((e) => e.id)).toEqual(['1']);
  });
});

describe('messages', () => {
  it('annonce une ou plusieurs histoires terminées', () => {
    expect(storiesDoneMessage(1)).toBe('Une histoire à laquelle tu as participé est terminée !');
    expect(storiesDoneMessage(5)).toBe('Cinq histoires auxquelles tu as participé sont terminées !');
    expect(storiesDoneMessage(14)).toBe('14 histoires auxquelles tu as participé sont terminées !');
  });

  it('félicite l’auteur d’une première case', () => {
    expect(inspiredMessage(3)).toBe('Ton dessin a inspiré 3 histoires différentes !');
    expect(bornFromYourDrawing(3)).toBe('Trois histoires sont nées de ton dessin !');
    expect(bornFromYourDrawing(1)).toBe('Une histoire est née de ton dessin !');
  });

  it('liste les auteurs du chemin sans doublon', () => {
    const path = [{ authorId: 'a', authorName: 'Alice' }, { authorId: 'b', authorName: 'Bob' }, { authorId: 'a', authorName: 'Alice' }, { authorId: 'c', authorName: 'Chloé' }];
    expect(distinctAuthors(path).map((a) => a.authorName)).toEqual(['Alice', 'Bob', 'Chloé']);
  });
});
