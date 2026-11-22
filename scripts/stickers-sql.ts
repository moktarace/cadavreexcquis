// Affiche la commande SQL qui synchronise les seuils de src/domain/stickers.ts avec le serveur.
// À exécuter ensuite dans l'éditeur SQL Supabase (aucun tampon déjà débloqué n'est retiré).
import { syncSql } from '../src/domain/stickers';

console.log(syncSql());
