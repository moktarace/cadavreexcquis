import { rpc } from '../multi/api';
import type { Activity } from './types';

export const fetchActivity = () => rpc<Activity>('survivor_activity');

/** `until` = le repère reçu avec le flux: les événements arrivés depuis ne sont pas marqués lus. */
export const markActivityRead = (until: string) => rpc<null>('survivor_activity_read', { p_until: until });

/** Première case lisible de chaque partie (règles de lecture du serveur: jamais la BD de l'adversaire en Duel en cours). */
export const fetchThumbs = (ids: readonly string[]) => rpc<{ game_id: string; image_path: string }[]>('survivor_game_thumbs', { p_games: ids });
