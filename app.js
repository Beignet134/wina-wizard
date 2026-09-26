// WIZARD_DATA est défini dans donnees.js (généré par wina_wizard.py à chaque run),
// chargé AVANT ce fichier dans index.html.
const BETS = WIZARD_DATA.bets;
const UNMATCHED = WIZARD_DATA.unmatched_examples;
const VALUE_BETS = WIZARD_DATA.value_bets;
const MIN_BETS = WIZARD_DATA.config.min_bets_for_verdict;
const OOS_MIN = WIZARD_DATA.config.oos_min_test;
const UPCOMING_DAYS = WIZARD_DATA.config.upcoming_days;
const MIN_EDGE = WIZARD_DATA.config.min_edge ?? 0.02;

// Libellé de ligue non ambigu. Un nom de ligue seul peut désigner des
// championnats totalement différents (ex. "Ligue 1" existe en France, en
// Algérie, en Afrique du Sud...) : on affiche donc toujours "Pays - Ligue",
// et les filtres par ligue se basent sur une clé combinée pays+ligue plutôt
// que sur le seul nom, pour ne jamais confondre deux compétitions homonymes.
const ligueLabel = (pays, ligue) => ligue ? (pays ? `${pays} - ${ligue}` : ligue) : "";
const ligueKey = (pays, ligue) => `${pays || ""}␟${ligue || ""}`;

// --- Filtre "marchés de queue" — Intervalle de buts / Plus-Moins de buts --
// Mesure empirique du 20/09/2026 (export réel, 3084 paris, ces deux
// catégories) : sur les marchés proches du total de buts le plus probable,
// le modèle est raisonnablement calibré (proba prédite ~1,1x le taux réel).
// Sur les extrémités de la distribution, l'écart explose en proportion :
// "Buts 7 et plus" prédisait 8,9 % pour 0 % de réussite réelle (N=26),
// "Plus de 5" 16,9 % pour 5,6 % (N=18), "Moins de 1" 15,5 % pour 6,9 %
// (N=29). Une petite erreur sur les buts attendus (λ) se répercute de façon
// très non-linéaire sur la probabilité d'un score extrême (Poisson/binomiale
// négative) — la correction ρ de Dixon-Coles ne corrige que les scores bas
// (0-0, 1-0, 0-1, 1-1), rien d'équivalent n'existe pour cette queue-ci.
// Volontairement scopé à CES DEUX catégories : rien n'indique le même biais
// ailleurs (1X2, Handicap...), donc pas de généralisation non justifiée —
// et volontairement une LISTE de marchés à exclure (pas une correction du
// modèle lui-même), pour rester un filtre réversible plutôt qu'un
// réétalonnage fitté sur cet échantillon (risque de surapprentissage sur à
// peine un mois de données, cf. discussion du 20/09/2026).
const CATEGORIES_FILTRE_QUEUE = new Set(["Intervalle de buts", "Plus/Moins de buts"]);
const MARCHES_QUEUE = new Set([
  "Buts 7 et plus",
  "Plus de 4", "Plus de 4.5", "Plus de 5",
  "Moins de 0.5", "Moins de 1",
]);

/* ============================================================
   MÉLANGE AVEC LE MARCHÉ
   ------------------------------------------------------------
   Au lieu d'opposer le modèle au marché, on part du prix du
   marché et on le corrige légèrement :

       p_finale = α · p_modèle + (1−α) · p_marché_dévigée

   Pourquoi : la cote de Winamax intègre les compositions, les
   blessures, la forme, l'argent parié — infiniment plus
   d'information que l'historique des buts. Le marché est donc
   bien calibré par construction, contrairement au modèle. Le
   mélange hérite de cette calibration tout en gardant la
   capacité à signaler un vrai désaccord.

   Conséquence remarquable : l'edge se réduit à α · edge_dévigé,
   ce qui permet de tout recalculer ici, sans repasser par
   Python. α = 1 revient au modèle seul, α = 0 au marché seul
   (donc aucun value bet, par construction).
   ============================================================ */

// --- Dimensionnement des mises (critere de Kelly) ----------------------
// Kelly donne la fraction de bankroll qui maximise la croissance a long
// terme :   f = (p * cote - 1) / (cote - 1)
// Le numerateur est exactement l'esperance du pari.
//
// POURQUOI UNE FRACTION DE KELLY, ET NON KELLY ENTIER
// Kelly suppose que la probabilite p est EXACTE. Celle du modele est
// surconfiante (ratio mesure 0,924 sur le backtest), donc Kelly entier
// sur-miserait systematiquement, avec des variations de bankroll brutales
// et un risque reel de ruine. Le quart de Kelly divise la volatilite par
// quatre en ne cedant qu'une petite part de la croissance theorique.
//
// Renvoie la fraction de bankroll a engager, bornee a MISE_PLAFOND : meme
// un edge enorme ne doit jamais concentrer la bankroll sur un seul pari,
// car un edge enorme trahit plus souvent une erreur du modele qu'une vraie
// occasion.
const MISE_PLAFOND = 0.10;

function kellyFraction(p, cote, fraction) {
  if (p == null || !cote || cote <= 1) return 0;
  const f = (p * cote - 1) / (cote - 1);
  if (!isFinite(f) || f <= 0) return 0;       // aucun edge : on ne mise pas
  return Math.min(f * fraction, MISE_PLAFOND);
}

// Lit la strategie choisie et renvoie la mise en euros pour un pari donne.
// "fixe" = le montant saisi ; sinon une fraction de la bankroll de depart.
function miseConseillee(v, selectId, miseFixe, bankroll) {
  const el = $(selectId);
  const strategie = el ? el.value : "fixe";
  if (strategie === "fixe" || !bankroll) return miseFixe;
  const frac = parseFloat(strategie);
  if (!isFinite(frac)) return miseFixe;
  const p = v.p_aff ?? v.p_model;
  return Math.round(kellyFraction(p, v.cote, frac) * bankroll * 100) / 100;
}

// --- Mode d'enrichissement xG ------------------------------------------
// Trois comportements :
//   "sans" : modele en buts seul, tous les matchs.
//   "avec" : lecture xG UNIQUEMENT, donc les matchs sans historique xG
//            suffisant disparaissent (environ 80 % d'entre eux).
//   "auto" : xG quand il est disponible, modele en buts sinon. Aucun match
//            n'est ecarte : on profite de l'xG la ou il existe sans perdre
//            le reste. C'est le meilleur compromis par defaut.
//
// "auto" melange donc deux lectures dans un meme ensemble. C'est assume :
// chaque pari garde la MEILLEURE estimation disponible pour SON match, ce
// qui vaut mieux que d'appliquer partout la moins informee, ou de jeter
// les quatre cinquiemes de l'echantillon.
function appliquerXg(rows, mode) {
  if (mode === "sans") return rows;
  const substituer = r => ({
    ...r,
    p_model: r.p_model_xg, edge: r.edge_xg, edge_devig: r.edge_devig_xg,
    ev: r.ev_xg, lam_home: r.lam_home_xg, lam_away: r.lam_away_xg,
    // Conservees a part pour l'infobulle, qui montre les deux lectures.
    p_model_buts: r.p_model, edge_buts: r.edge, edge_devig_buts: r.edge_devig,
    lam_home_buts: r.lam_home, lam_away_buts: r.lam_away,
    source_xg: true,
  });
  if (mode === "avec") return rows.filter(r => r.p_model_xg != null).map(substituer);
  // mode "auto"
  return rows.map(r => (r.p_model_xg != null ? substituer(r) : {...r, source_xg: false}));
}

// --- Lecture binomiale négative (facultative, off par défaut) ----------
// Simple bascule (pas de mode "auto" comme l'xG) : p_model_nb existe pour
// chaque pari dès qu'un r global a pu être estimé sur le backtest (voir
// estimer_dispersion_nbinom côté Python) — il n'y a pas de sous-ensemble de
// matchs à exclure comme pour l'xG (historique insuffisant).
//
// Volontairement EXCLUSIF avec l'enrichissement xG (voir l'appelant) : les
// deux lectures portent sur des choses différentes — l'xG change le λ
// estimé, la binomiale négative change la VARIANCE autour du même λ — et
// p_model_nb n'a été calculé que sur le λ "buts", jamais sur le λ mélangé à
// l'xG. Les combiner donnerait un résultat que personne ne pourrait
// interpréter correctement.
// Note affichée sous le sélecteur "Loi statistique (buts)", sur les deux
// pages qui le proposent (préfixe "bt" ou "u"). Centralisée ici pour ne pas
// dupliquer la logique de disponibilité/exclusivité avec l'xG.
function majLoiNote(prefixe) {
  const note = $(prefixe + "LoiNote");
  const sel = $(prefixe + "Loi");
  if (!note || !sel) return;
  if (!NB_R) {
    note.style.display = "none";
    return;
  }
  if (sel.value !== "nbinom") {
    note.style.display = "none";
    return;
  }
  const modeXg = $(prefixe + "Enrichi") ? $(prefixe + "Enrichi").value : "sans";
  note.style.display = "";
  if (modeXg !== "sans") {
    note.innerHTML = `<strong>Sans effet ici</strong> — l'enrichissement xG est actif et prend `
      + `le pas sur ce filtre (les deux ne se combinent pas, voir l'infobulle du panneau `
      + `« Binomiale négative » sur DC rétrospectif). Repassez l'enrichissement xG sur « Sans » `
      + `pour comparer Poisson et binomiale négative.`;
  } else {
    const v = NB_VALIDATION || {};
    note.innerHTML = `<strong>Binomiale négative active</strong> — r estimé = ${v.r_estime}`
      + (v.brier_gain_pct != null ? `, gain de Brier ${v.brier_gain_pct > 0 ? "+" : ""}${v.brier_gain_pct} % sur le backtest` : "")
      + `. Diagnostic complet sur DC rétrospectif. N'affecte que ce filtre : les autres pages `
      + `et l'export continuent d'utiliser Poisson tant qu'il reste le réglage par défaut ici.`;
  }
}

function appliquerNb(rows, actif) {
  if (!actif) return rows;
  return rows.map(r => (r.p_model_nb == null ? r : {
    ...r,
    p_model: r.p_model_nb, edge: r.edge_nb, edge_devig: r.edge_devig_nb, ev: r.ev_nb,
    // Conservées à part pour l'infobulle, qui montre les deux lectures.
    p_model_poisson: r.p_model, edge_poisson: r.edge, edge_devig_poisson: r.edge_devig,
    source_nb: true,
  }));
}

// --- Type de pari : selection multiple par cases a cocher ---------------
// Renvoie la liste des categories cochees. Un ensemble VIDE (aucune case)
// est traite comme "toutes" : afficher zero pari quand l'utilisateur
// decoche tout serait une impasse, et laisserait croire a un bug.
function categoriesCochees(prefixe) {
  const boites = document.querySelectorAll("." + prefixe + "CatChk");
  if (!boites.length) return null;                 // filtre absent
  const choisies = [...boites].filter(b => b.checked).map(b => b.value);
  return choisies.length ? choisies : null;        // rien coche = pas de filtre
}

// --- Ligue : meme principe, en Set (beaucoup plus d'options qu'il n'y a
// de categories) et sans case pre-cochee au depart : ne rien cocher = ne
// rien exclure, exactement le comportement de l'ancien <select value="">
// qu'il remplace. La liste des cases est peuplee dynamiquement dans
// initMeta() (les ligues dependent des donnees du jour), donc cette
// fonction n'est fiable qu'appelee apres coup — c'est toujours le cas ici,
// les fonctions de rendu ne tournant qu'au clic/au chargement complet.
function liguesCochees(prefixe) {
  const boites = document.querySelectorAll("." + prefixe + "LigueChk");
  if (!boites.length) return null;
  const choisies = [...boites].filter(b => b.checked).map(b => b.value);
  return choisies.length ? new Set(choisies) : null;
}

function blendAlpha(selectId) {
  const el = $(selectId);
  const v = el ? parseFloat(el.value) : 1;
  return isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
}

// Probabilité du marché, marge retirée, reconstituée depuis les données.
function pMarche(r) {
  if (r.p_implied_devig != null) return r.p_implied_devig;
  if (r.edge_devig != null && r.p_model != null) return r.p_model - r.edge_devig;
  return r.cote ? 1 / r.cote : null;
}

// Renvoie {p, edge, ev} après mélange, pour un pari et un α donnés.
// --- Correction de calibration ---------------------------------------
// Le modèle surestime systématiquement ses probabilités : mesuré à un
// ratio réel/annoncé de 0,924 sur 1107 paris, identique (à la 3e décimale)
// sur chacune des deux moitiés de la période testée séparément. Ce filtre
// applique ce facteur AVANT tout autre traitement, de sorte que l'edge et
// l'espérance qui en découlent reposent sur une probabilité corrigée du
// biais plutôt que sur celle, trop optimiste, produite par le modèle.
//
// À appliquer sur TOUT l'échantillon, jamais par-dessus des filtres qui
// ont déjà sélectionné leurs paris : testé, la correction dégrade alors
// les résultats, parce que ces filtres retiennent déjà les paris les mieux
// calibrés et que les corriger à la baisse les pénalise à tort.
const CALIB_RATIO = (WIZARD_DATA.dc_stats || {}).calib_ratio || null;

// --- Lecture binomiale négative (facultative, filtre off par défaut) ---
// r_estime/validation calculés côté Python (build_dc_backtest →
// estimer_dispersion_nbinom + valider_nbinom) sur le MÊME backtest que
// CALIB_RATIO. Voir appliquerNb plus bas pour la substitution.
const NB_VALIDATION = (WIZARD_DATA.dc_stats || {}).nb_validation || null;
const NB_R = (NB_VALIDATION && NB_VALIDATION.r_estime) || null;

function calibrer(rows, actif) {
  if (!actif || !CALIB_RATIO) return rows;
  const k = CALIB_RATIO;
  return rows.map(r => {
    const o = Object.assign({}, r);
    // La probabilité du MARCHÉ dévigué ne bouge pas : ce n'est pas elle
    // qui est mal calibrée, c'est celle du modèle. On la reconstitue avant
    // correction pour recalculer l'edge dévigué sur la bonne référence.
    const pMarcheDevig = (r.p_model != null && r.edge_devig != null)
                       ? r.p_model - r.edge_devig : null;
    if (o.p_model != null) {
      o.p_model = r.p_model * k;
      if (r.cote) o.edge = o.p_model - 1 / r.cote;
      if (pMarcheDevig != null) o.edge_devig = o.p_model - pMarcheDevig;
      if (r.cote) o.ev = o.p_model * (r.cote - 1) - (1 - o.p_model);
    }
    if (o.p_model_xg != null) {
      const pMarcheXg = (r.edge_devig_xg != null) ? r.p_model_xg - r.edge_devig_xg : null;
      o.p_model_xg = r.p_model_xg * k;
      if (r.cote) o.edge_xg = o.p_model_xg - 1 / r.cote;
      if (pMarcheXg != null) o.edge_devig_xg = o.p_model_xg - pMarcheXg;
      if (r.cote) o.ev_xg = o.p_model_xg * (r.cote - 1) - (1 - o.p_model_xg);
    }
    return o;
  });
}

// Découpe "min-max" en bornes numériques. Les plages sont exclusives à
// gauche et inclusives à droite ("2-4" = 2,01 à 4,00), pour qu'une cote
// tombant pile sur une borne n'apparaisse pas dans deux plages à la fois.
function dansPlageCote(cote, plage) {
  if (!plage || cote == null) return true;
  const [lo, hi] = plage.split("-").map(Number);
  return cote > lo && cote <= hi;
}

function blended(r, alpha) {
  const pm = pMarche(r);
  if (pm == null) return {p: r.p_model, edge: r.edge, ev: r.ev};
  const p = alpha * r.p_model + (1 - alpha) * pm;
  return {
    p,
    edge: p - pm,                       // = alpha * edge_dévigé
    ev: p * (r.cote - 1) - (1 - p),
  };
}
const TEAM_STATS = WIZARD_DATA.team_stats;

// Peuple les éléments d'en-tête (cartes, dates...) qui étaient auparavant
// générés côté Python directement dans le HTML.
function relativeTime(isoString) {
  if (!isoString) return "";
  const then = new Date(isoString);
  if (isNaN(then.getTime())) return "";
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function initMeta() {
  const m = WIZARD_DATA.meta;
  const rel = relativeTime(WIZARD_DATA.generated_iso);
  $("metaGenerated").textContent = WIZARD_DATA.generated + (rel ? ` (${rel})` : "");
  $("metaOddsFiles").textContent = m.n_odds_files;
  $("metaResultsFiles").textContent = m.n_results_files;
  $("metaOddsDedup").textContent = m.n_odds_dedup;
  $("metaOddsRaw").textContent = " / " + m.n_odds_raw;
  $("metaMatched").textContent = m.matched;
  $("metaUnmatched").textContent = m.unmatched;
  $("metaPoissonScored").textContent = WIZARD_DATA.poisson_stats.n_matches_scored;
  $("metaPoissonSkipped").textContent = WIZARD_DATA.poisson_stats.n_skipped_history;
  $("metaUpcomingDays").textContent = UPCOMING_DAYS;

  // Options de ligue du filtre (autrefois générées côté Python). La VALEUR
  // de chaque option est la clé combinée pays+ligue (ligueKey) — jamais le
  // seul nom de ligue, qui peut être partagé par plusieurs pays — tandis que
  // le TEXTE affiché est "Pays - Ligue" (ligueLabel), pour qu'on distingue
  // d'un coup d'œil deux championnats homonymes dans le menu déroulant.
  const ligueOptions = (rows) => {
    const parKey = new Map();
    rows.forEach(r => { if (r.ligue && !parKey.has(ligueKey(r.pays, r.ligue))) parKey.set(ligueKey(r.pays, r.ligue), r); });
    return [...parKey.values()].sort((a, b) => ligueLabel(a.pays, a.ligue).localeCompare(ligueLabel(b.pays, b.ligue)));
  };
  const remplirLigues = (sel, rows) => {
    if (!sel) return;
    ligueOptions(rows).forEach(r => {
      const o = document.createElement("option");
      o.value = ligueKey(r.pays, r.ligue); o.textContent = ligueLabel(r.pays, r.ligue);
      sel.appendChild(o);
    });
  };
  remplirLigues($("fLigue"), BETS);

  // Filtre Ligue des pages DC rétrospectif / Paris à venir : même widget
  // "menu déroulant à cases à cocher" que Type de pari (voir libelleMsel),
  // mais peuplé ici plutôt qu'écrit en dur dans le HTML — contrairement aux
  // 4 catégories fixes, la liste des ligues dépend des données du jour.
  // Aucune case n'est pré-cochée : ne rien cocher = ne rien exclure,
  // exactement le comportement de l'ancien <select value=""> remplacé.
  const remplirLiguesMsel = (prefixe, rows) => {
    const conteneur = $(prefixe + "LigueOptions");
    if (!conteneur) return;
    conteneur.innerHTML = "";
    ligueOptions(rows).forEach(r => {
      const texte = ligueLabel(r.pays, r.ligue);
      const label = document.createElement("label");
      label.className = "chk-cat";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = prefixe + "LigueChk";
      input.value = ligueKey(r.pays, r.ligue);
      input.dataset.label = texte;
      const span = document.createElement("span");
      span.textContent = texte;
      label.appendChild(input);
      label.appendChild(span);
      conteneur.appendChild(label);
    });
  };
  // Même liste pour les deux pages : l'UNION des ligues du backtest ET des
  // value bets à venir, pas seulement ces dernières — sinon les deux menus
  // n'auraient pas les mêmes cases et la liaison entre les deux pages (plus
  // bas) échouerait silencieusement dès qu'une valeur de l'un est absente
  // de la liste de l'autre.
  if ($("btLigueOptions") || $("uLigueOptions")) {
    const toutes = [...(WIZARD_DATA.dc_backtest || []), ...(WIZARD_DATA.value_bets || [])];
    remplirLiguesMsel("bt", toutes);
    remplirLiguesMsel("u", toutes);
  }
}

BETS.forEach((b,i) => b.id = i);
const selected = new Set();

const $ = id => document.getElementById(id);
const fmtEur = x => (x>=0?"+":"") + x.toLocaleString("fr-FR",{maximumFractionDigits:2}) + " €";
const fmtPct = x => (x==null||isNaN(x)) ? "—" : (x>=0?"+":"") + (x*100).toFixed(1) + " %";
initMeta();  // appelé ici : $ est maintenant défini

/* ---------- Navigation par onglets ---------- */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    $("page-" + tab.dataset.page).classList.add("active");
    window.scrollTo({top:0, behavior:"instant"});
  });
});

/* ================= PAGE 1 — RÉTROSPECTIF ================= */

// Remplit le menu "Pari précis" avec les colonnes distinctes présentes
(function initPariFilter() {
  const cols = [...new Set(BETS.map(b => b.col))];
  // Tri intelligent : scores exacts en ordre numérique, puis le reste alpha
  cols.sort((a,b) => {
    const pa = a.match(/^(\d+) - (\d+)$/), pb = b.match(/^(\d+) - (\d+)$/);
    if (pa && pb) return (+pa[1]-+pb[1]) || (+pa[2]-+pb[2]);
    if (pa && !pb) return 1; if (!pa && pb) return -1;
    return a.localeCompare(b);
  });
  const sel = $("fPari");
  cols.forEach(c => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c; sel.appendChild(o);
  });
})();

function currentFilters() {
  return {
    cat: $("fCat").value,
    pari: $("fPari").value,
    ligue: $("fLigue").value,
    coteMin: parseFloat($("fCoteMin").value),
    coteMax: parseFloat($("fCoteMax").value),
    search: $("fSearch").value.trim().toLowerCase(),
    only: $("onlySel").value,
  };
}

function passesFilter(b, f) {
  if (f.cat && b.cat !== f.cat) return false;
  if (f.pari && b.col !== f.pari) return false;
  if (f.ligue && ligueKey(b.pays, b.ligue) !== f.ligue) return false;
  if (!isNaN(f.coteMin) && b.cote < f.coteMin) return false;
  if (!isNaN(f.coteMax) && b.cote > f.coteMax) return false;
  if (f.search && !(b.match.toLowerCase().includes(f.search))) return false;
  if (f.only === "selected" && !selected.has(b.id)) return false;
  return true;
}

// Quand la catégorie change, restreindre les paris proposés à cette catégorie
$("fCat").addEventListener("change", () => {
  const cat = $("fCat").value;
  const cols = [...new Set(BETS.filter(b => !cat || b.cat===cat).map(b => b.col))];
  cols.sort((a,b) => {
    const pa=a.match(/^(\d+) - (\d+)$/), pb=b.match(/^(\d+) - (\d+)$/);
    if (pa&&pb) return (+pa[1]-+pb[1])||(+pa[2]-+pb[2]);
    if (pa&&!pb) return 1; if(!pa&&pb) return -1; return a.localeCompare(b);
  });
  const sel = $("fPari"), cur = sel.value;
  sel.innerHTML = '<option value="">Tous</option>';
  cols.forEach(c => { const o=document.createElement("option"); o.value=c; o.textContent=c; sel.appendChild(o); });
  if (cols.includes(cur)) sel.value = cur;
});

function betGain(b, stake) { return b.won ? stake*(b.cote-1) : -stake; }
let sortKey = "date", sortDir = 1;

function computeFiltered() {
  const f = currentFilters();
  return BETS.filter(b => passesFilter(b, f));
}

function updateKPIs(rows, stake) {
  const n = rows.length, mise = n*stake;
  let net = 0, wins = 0;
  rows.forEach(b => { net += betGain(b, stake); if (b.won) wins++; });
  $("kNb").textContent = n;
  $("kMise").textContent = mise.toLocaleString("fr-FR") + " €";
  const netEl = $("kNet"); netEl.textContent = fmtEur(net); netEl.className = "v " + (net>=0?"pos":"neg");
  const roiEl = $("kRoi"); const roi = mise>0 ? net/mise : null;
  roiEl.textContent = fmtPct(roi); roiEl.className = "v " + (roi>=0?"pos":"neg");
  $("kWin").textContent = n>0 ? (wins/n*100).toFixed(1)+" %" : "—";
}

function updateCategoryTable(rows, stake) {
  const cats = {};
  rows.forEach(b => { (cats[b.cat] = cats[b.cat] || []).push(b); });
  const order = Object.keys(cats).map(cat => {
    const arr = cats[cat].slice().sort((a,b)=> a.date<b.date?-1:1);
    const n = arr.length;
    const net = arr.reduce((s,b)=>s+betGain(b,stake),0);
    const roi = n>0 ? net/(n*stake) : null;
    const wins = arr.filter(b=>b.won).length;
    const avgCote = n>0 ? arr.reduce((s,b)=>s+b.cote,0)/n : 0;
    const split = Math.floor(n/2);
    const test = arr.slice(split);
    const testNet = test.reduce((s,b)=>s+betGain(b,stake),0);
    const testRoi = test.length>0 ? testNet/(test.length*stake) : null;
    const trainNet = arr.slice(0,split).reduce((s,b)=>s+betGain(b,stake),0);
    const trainRoi = split>0 ? trainNet/(split*stake) : null;
    let verdict;
    if (n<MIN_BETS || test.length<OOS_MIN) verdict = ["Données insuffisantes","#555"];
    else if (trainRoi>0 && testRoi>0) verdict = ["Tient en test","#1a7f5a"];
    else if (trainRoi>0 && testRoi<=0) verdict = ["Disparaît en test","#b23b3b"];
    else verdict = ["Non rentable","#8a6d1f"];
    return {cat,n,roi,winRate:n>0?wins/n:0,avgCote,testRoi,verdict};
  }).sort((a,b)=> (b.roi||-99)-(a.roi||-99));

  $("catBody").innerHTML = order.map(o => `
    <tr>
      <td data-label=""><strong>${o.cat}</strong></td>
      <td data-label="Nb paris" class="num">${o.n}</td>
      <td data-label="ROI global" class="num ${o.roi>=0?'pos':'neg'}"><strong>${fmtPct(o.roi)}</strong></td>
      <td data-label="Réussite" class="num">${(o.winRate*100).toFixed(1)} %</td>
      <td data-label="Cote moy." class="num">${o.avgCote.toFixed(2)}</td>
      <td data-label="ROI test" class="num ${o.testRoi>=0?'pos':'neg'}">${fmtPct(o.testRoi)}</td>
      <td data-label="Verdict"><span class="badge" style="background:${o.verdict[1]}">${o.verdict[0]}</span></td>
    </tr>`).join("") || `<tr><td colspan="7" class="muted">Aucun pari ne correspond aux filtres.</td></tr>`;
}

// Min/max d'un tableau SANS spread (Math.min(...arr)) : au-delà d'environ
// 65 000 éléments, étaler un tableau en arguments individuels dépasse la
// limite de la pile d'appel du moteur JS ("Maximum call stack size
// exceeded") — silencieux à petite échelle, mais devenu réel le 26/09/2026
// avec 130 042 paris évalués sur Rétrospectif (page qui affiche TOUS les
// paris, sans plafond), qui a fait planter le script entier en cours de
// route : plus aucune page ne se rendait après ce point, y compris la Vue
// d'ensemble pourtant sans rapport (un script <script> classique s'arrête
// net à la première exception non rattrapée). reduce() n'a aucune limite de
// ce genre, quelle que soit la taille du tableau.
function arrMin(a) { return a.reduce((m, x) => x < m ? x : m, a[0]); }
function arrMax(a) { return a.reduce((m, x) => x > m ? x : m, a[0]); }

function drawChart(rows, stake, wrapId, height) {
  const wrap = $(wrapId || "chartWrap");
  const H = height || 320;
  const sorted = rows.slice().sort((a,b)=> a.date<b.date?-1:(a.date>b.date?1:0));
  if (sorted.length === 0) {
    wrap.innerHTML = '<p class="muted">Aucun pari à afficher avec les filtres actuels.</p>';
    return;
  }
  let cum = 0;
  const pts = sorted.map((b,i) => {
    cum += betGain(b, stake);
    return {x:i+1, y:cum, date:b.date, match:b.match, col:b.col, cote:b.cote, won:b.won};
  });

  const W = 1180, padL = 62, padR = 22, padT = 26, padB = 38;
  const ys = pts.map(p=>p.y).concat([0]);
  const xMin = 1, xMax = Math.max(2, pts.length);
  let yMin = arrMin(ys), yMax = arrMax(ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax-yMin)*0.12; yMin -= yPad; yMax += yPad;
  const sx = x => padL + (x-xMin)/(xMax-xMin)*(W-padL-padR);
  const sy = y => padT + (yMax-y)/(yMax-yMin)*(H-padT-padB);

  const positive = cum >= 0;
  const stroke = positive ? "var(--up)" : "var(--down)";
  const gradId = (wrapId || "chartWrap") + "-grad";

  // Aire sous la courbe (dégradé) : rend la tendance lisible d'un coup d'oeil.
  const line = pts.map((p,i)=> (i?"L":"M")+sx(p.x).toFixed(1)+" "+sy(p.y).toFixed(1)).join(" ");
  const baseY = sy(Math.max(yMin, Math.min(0, yMax)));
  const area = `M${sx(pts[0].x).toFixed(1)} ${baseY.toFixed(1)} ` +
    pts.map(p=>"L"+sx(p.x).toFixed(1)+" "+sy(p.y).toFixed(1)).join(" ") +
    ` L${sx(pts[pts.length-1].x).toFixed(1)} ${baseY.toFixed(1)} Z`;

  // Repères horizontaux
  let yticks = "";
  for (let i=0;i<=4;i++) {
    const yv = yMin + (yMax-yMin)*i/4, yy = sy(yv);
    yticks += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-padR}" y2="${yy.toFixed(1)}" stroke="var(--line-soft)" opacity=".7"/>
      <text x="${padL-10}" y="${(yy+4).toFixed(1)}" text-anchor="end" class="chart-tip" fill="var(--ink-faint)">${Math.round(yv)} €</text>`;
  }
  const zeroLine = (0>=yMin && 0<=yMax)
    ? `<line class="zeroline" x1="${padL}" y1="${sy(0).toFixed(1)}" x2="${W-padR}" y2="${sy(0).toFixed(1)}"/>` : "";

  let xticks = ""; const step = Math.max(1, Math.floor(pts.length/7));
  for (let i=0;i<pts.length;i+=step) {
    xticks += `<text x="${sx(pts[i].x).toFixed(1)}" y="${H-12}" text-anchor="middle" class="chart-tip" fill="var(--ink-faint)">${pts[i].date.slice(5)}</text>`;
  }

  // Points remarquables : sommet, creux, valeur finale.
  let maxP = pts[0], minP = pts[0];
  pts.forEach(p => { if (p.y > maxP.y) maxP = p; if (p.y < minP.y) minP = p; });
  const last = pts[pts.length-1];
  const marker = (p, label, color) => `
    <g class="chart-marker">
      <circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="7" fill="${color}" opacity=".18"/>
      <circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3.5" fill="${color}"/>
      <text x="${sx(p.x).toFixed(1)}" y="${(sy(p.y)-13).toFixed(1)}" text-anchor="middle"
            class="chart-badge" fill="${color}">${label}</text>
    </g>`;
  let markers = "";
  if (pts.length > 3 && maxP !== minP) {
    markers += marker(maxP, "MAX", "var(--up)");
    markers += marker(minP, "MIN", "var(--down)");
  }

  // Petits points sur chaque pari, discrets, quand le volume le permet.
  let dots = "";
  if (pts.length <= 60) {
    dots = pts.map(p => `<circle class="chart-dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.5" fill="${stroke}"/>`).join("");
  }

  wrap.innerHTML = `
    <div class="chart-holder">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Évolution du gain cumulé">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${positive ? '#34d399' : '#fb7185'}" stop-opacity=".28"/>
            <stop offset="100%" stop-color="${positive ? '#34d399' : '#fb7185'}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${yticks}${zeroLine}
        <path class="chart-area" d="${area}" fill="url(#${gradId})"/>
        <path class="curve" d="${line}" stroke="${stroke}"/>
        ${dots}${markers}
        <line class="chart-cursor" x1="0" y1="${padT}" x2="0" y2="${H-padB}" opacity="0"/>
        <circle class="chart-cursor-dot" r="4.5" opacity="0"/>
        ${xticks}
        <rect class="chart-hit" x="${padL}" y="${padT}" width="${W-padL-padR}" height="${H-padT-padB}" fill="transparent"/>
      </svg>
      <div class="chart-tooltip" hidden></div>
    </div>`;

  // Effet "dessiné en direct" au premier affichage : la ligne se trace
  // plutôt que d'apparaître d'un coup — l'aire, les points et les repères
  // MAX/MIN suivent juste après (voir les animations CSS .chart-area/
  // .chart-dot/.chart-marker). Purement cosmétique, sans état à mémoriser :
  // changer un filtre redessine tout à l'identique. getTotalLength() n'a de
  // sens qu'une fois le <path> dans le DOM, d'où ce bloc après l'injection.
  const curvePath = wrap.querySelector(".curve");
  if (curvePath) {
    const len = curvePath.getTotalLength();
    curvePath.style.strokeDasharray = len;
    curvePath.style.strokeDashoffset = len;
    curvePath.getBoundingClientRect();  // force le reflow avant de lancer la transition
    curvePath.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)";
    requestAnimationFrame(() => { curvePath.style.strokeDashoffset = "0"; });
  }

  // --- Interaction : ligne de suivi + infobulle ---
  const holder = wrap.querySelector(".chart-holder");
  const svg = holder.querySelector("svg");
  const cursor = holder.querySelector(".chart-cursor");
  const cursorDot = holder.querySelector(".chart-cursor-dot");
  const tip = holder.querySelector(".chart-tooltip");

  function hide() {
    cursor.setAttribute("opacity", "0");
    cursorDot.setAttribute("opacity", "0");
    tip.hidden = true;
  }

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const relX = (clientX - rect.left) / rect.width * W;   // coordonnées internes du SVG
    if (relX < padL - 4 || relX > W - padR + 4) { hide(); return; }

    // Point le plus proche horizontalement
    let best = pts[0], bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(sx(p.x) - relX);
      if (d < bestD) { bestD = d; best = p; }
    }
    const px = sx(best.x), py = sy(best.y);

    cursor.setAttribute("x1", px.toFixed(1));
    cursor.setAttribute("x2", px.toFixed(1));
    cursor.setAttribute("opacity", "1");
    cursorDot.setAttribute("cx", px.toFixed(1));
    cursorDot.setAttribute("cy", py.toFixed(1));
    cursorDot.setAttribute("fill", stroke);
    cursorDot.setAttribute("opacity", "1");

    const issue = best.won
      ? '<span class="tt-win">Gagné</span>'
      : '<span class="tt-lose">Perdu</span>';
    tip.innerHTML = `
      <div class="tt-date">${best.date}</div>
      <div class="tt-match">${best.match || ""}</div>
      <div class="tt-row"><span>${best.col || ""} · cote ${best.cote != null ? best.cote.toFixed(2) : "—"}</span>${issue}</div>
      <div class="tt-cum">Cumul <strong class="${best.y>=0?'pos':'neg'}">${fmtEur(best.y)}</strong></div>`;
    tip.hidden = false;

    // Positionne l'infobulle en pixels réels, en la gardant dans le cadre
    const pxReal = px / W * rect.width;
    const pyReal = py / H * rect.height;
    const tw = tip.offsetWidth || 190;
    let left = pxReal + 14;
    if (left + tw > rect.width) left = pxReal - tw - 14;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = Math.max(4, Math.min(pyReal - 10, rect.height - (tip.offsetHeight||90) - 4)) + "px";
  }

  const hit = holder.querySelector(".chart-hit");
  hit.addEventListener("mousemove", onMove);
  hit.addEventListener("mouseleave", hide);
  hit.addEventListener("touchstart", onMove, {passive:true});
  hit.addEventListener("touchmove", onMove, {passive:true});
  hit.addEventListener("touchend", hide);
}

function renderTable(rows, stake) {
  rows = rows.slice().sort((a,b)=>{
    let va, vb;
    if (sortKey === "gain") { va = betGain(a,stake); vb = betGain(b,stake); }
    else { va = a[sortKey]; vb = b[sortKey]; }
    if (va<vb) return -sortDir; if (va>vb) return sortDir; return 0;
  });
  const shown = rows.slice(0, 400);
  $("betBody").innerHTML = shown.map(b => {
    const g = betGain(b, stake);
    return `<tr>
      <td data-label=""><input type="checkbox" class="chk rowchk" data-id="${b.id}" ${selected.has(b.id)?"checked":""}></td>
      <td data-label="Date">${b.date}</td><td data-label="Match">${b.match}</td><td data-label="Ligue"><span class="pill">${ligueLabel(b.pays, b.ligue)}</span></td>
      <td data-label="Catégorie" class="tag-cat">${b.cat}</td><td data-label="Pari">${b.col}</td>
      <td data-label="Cote" class="num">${b.cote.toFixed(2)}</td>
      <td data-label="Résultat">${b.won?'<span class="pos">Gagné</span>':'<span class="neg">Perdu</span>'}</td>
      <td data-label="Gain/perte" class="num ${g>=0?'pos':'neg'}">${fmtEur(g)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="muted">Aucun pari ne correspond aux filtres.</td></tr>`;
  document.querySelectorAll(".rowchk").forEach(chk => {
    chk.addEventListener("change", e => {
      const id = parseInt(e.target.dataset.id);
      if (e.target.checked) selected.add(id); else selected.delete(id);
      if (currentFilters().only === "selected") refresh(); else updateAllButTable();
    });
  });
  $("rowInfo").textContent = `${rows.length} pari(s) retenu(s)` + (rows.length>400?" (400 affichés)":"");
}

let lastFilteredRows = [];
function updateAllButTable() {
  const stake = parseFloat($("stake").value) || 0;
  updateKPIs(lastFilteredRows, stake);
  updateCategoryTable(lastFilteredRows, stake);
  drawChart(lastFilteredRows, stake);
}
function refresh() {
  const stake = parseFloat($("stake").value) || 0;
  lastFilteredRows = computeFiltered();
  updateKPIs(lastFilteredRows, stake);
  updateCategoryTable(lastFilteredRows, stake);
  drawChart(lastFilteredRows, stake);
  renderTable(lastFilteredRows, stake);
}
["stake","fCat","fPari","fLigue","fCoteMin","fCoteMax","fSearch","onlySel"].forEach(id => {
  const el = $(id); el.addEventListener("input", refresh); el.addEventListener("change", refresh);
});
document.querySelectorAll("#betTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
    document.querySelectorAll("#betTable th.sortable .arrow").forEach(a=>a.textContent="");
    th.querySelector(".arrow").textContent = sortDir>0 ? "▲" : "▼";
    renderTable(lastFilteredRows, parseFloat($("stake").value)||0);
  });
});
$("chkAll").addEventListener("change", e => {
  if (e.target.checked) lastFilteredRows.forEach(b=>selected.add(b.id));
  else lastFilteredRows.forEach(b=>selected.delete(b.id));
  refresh();
});
// --- Générateur d'alias : "copier l'entrée Python" ------------------------
// Les panneaux de diagnostic ci-dessous (matchs non rapprochés, compétitions
// non alignées) affichent déjà le nom EXACT côté résultats à côté du nom
// Winamax — tout ce qu'il faut pour écrire un alias, sauf le taper à la
// main. Cette section génère la ligne Python prête à coller directement à
// partir de ces deux noms, avec la MÊME normalisation que normalize_name()
// côté Python (accents retirés, minuscules, ponctuation aplatie) : copier
// colle un texte qui matche vraiment la clé que le script calculerait lui-
// même, pas une approximation.
function normalizeNameJs(name) {
  if (!name) return "";
  let s = String(name);
  // þ islandais (ex: "Þór Akureyri") : même traitement que ø/æ, voir
  // normalize_name côté Python pour le détail (near-miss "Þór"/"Thór").
  s = s.replace(/ø/g, "o").replace(/Ø/g, "O").replace(/æ/g, "ae").replace(/Æ/g, "Ae")
       .replace(/þ/g, "th").replace(/Þ/g, "Th");
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9 ]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Copie dans le presse-papiers avec repli si l'API est refusée (fréquent en
// ouverture de fichier local, file://) — même mécanisme que "Copier le
// texte" de la page Bankroll (initCopyPlaced), pour rester cohérent.
async function copierTexte(texte, btn) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(texte);
    btn.textContent = "Copié !";
  } catch {
    // Repli : place le texte dans un champ temporaire sélectionné, l'utilisateur
    // n'a plus qu'à faire Ctrl+C — pas de presse-papiers auto sans API.
    const ta = document.createElement("textarea");
    ta.value = texte; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); btn.textContent = "Copié !"; }
    catch { btn.textContent = "Sélectionne + Ctrl+C"; }
    document.body.removeChild(ta);
  }
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
}

// Suggestion TEAM_ALIASES à partir d'un exemple non rapproché avec near-miss.
// t.candidat a la forme "Home - Away (Pays · Ligue)" (voir build_evaluated_bets
// côté Python) ; t.match la forme "Home - Away" côté Winamax. Une ligne par
// équipe dont le nom normalisé diffère réellement ; la forme la plus COURTE
// devient la clé et la plus longue la valeur canonique — la même convention
// que celle suivie à la main dans tout TEAM_ALIASES existant (ex: 'psg':
// 'paris saint germain'). Reste une SUGGESTION : à relire avant de coller,
// exactement comme pour les 116 alias ajoutés aujourd'hui à la main.
function suggestionAliasEquipes(t) {
  if (!t.candidat || !t.match || t.match.indexOf(" - ") < 0) return null;
  const m = t.candidat.match(/^(.+?) - (.+?)\s*\(/);
  if (!m) return null;
  const [homeOdds, awayOdds] = t.match.split(" - ", 2);
  const [, homeRes, awayRes] = m;
  const lignes = [];
  [[homeOdds, homeRes], [awayOdds, awayRes]].forEach(([a, b]) => {
    const na = normalizeNameJs(a), nb = normalizeNameJs(b);
    if (!na || !nb || na === nb) return;
    const [court, long] = na.length <= nb.length ? [na, nb] : [nb, na];
    lignes.push(`    '${court}': '${long}',`);
  });
  return lignes.length ? lignes.join("\n") : null;
}

// Suggestion PAYS_ALIASES_RESULTATS / LEAGUE_ALIASES_RESULTATS à partir
// d'une ligue non alignée. cle = "Pays — Ligue" côté Winamax, candidat =
// "Pays — Ligue" réel côté résultats (voir ligues_non_alignees_detail).
function suggestionAliasLigue(cle, candidat) {
  const partsOdds = cle.split(" — "), partsRes = candidat.split(" — ");
  if (partsOdds.length < 2 || partsRes.length < 2) return null;
  const [paysOdds, ligueOdds] = partsOdds, [paysRes, ligueRes] = partsRes;
  const nPaysOdds = normalizeNameJs(paysOdds), nPaysRes = normalizeNameJs(paysRes);
  const nLigueOdds = normalizeNameJs(ligueOdds), nLigueRes = normalizeNameJs(ligueRes);
  const lignes = [];
  if (nPaysOdds !== nPaysRes) {
    lignes.push(`    "${nPaysRes}": "${nPaysOdds}",   # PAYS_ALIASES_RESULTATS`);
  }
  if (nLigueOdds !== nLigueRes || nPaysOdds !== nPaysRes) {
    lignes.push(`    ("${nPaysOdds}", "${nLigueRes}"): "${nLigueOdds}",   # LEAGUE_ALIASES_RESULTATS`);
  }
  return lignes.length ? lignes.join("\n") : null;
}

// Un seul écouteur délégué pour tous les boutons "Copier l'entrée Python",
// quel que soit le panneau : évite d'en attacher un par ligne générée.
document.addEventListener("click", e => {
  const btn = e.target.closest(".btn-copy-alias");
  if (!btn) return;
  copierTexte(decodeURIComponent(btn.dataset.alias || ""), btn);
});

// Un exemple non rapproché est un objet {match, pays, ligue, date, candidat,
// score, candidat_pays, candidat_ligue, ligue_ok} — les 3 derniers champs
// (ajout du 25/09/2026) distinguent une vérification de DATE/LIGUE d'une
// vérification de NOM : la date est toujours la même par construction
// (find_result_for ne cherche jamais un autre jour), affichée quand même en
// vert pour rassurer explicitement. La ligue n'est PAS garantie : la
// recherche de candidat prend le nom le plus proche CE JOUR-LÀ toutes
// compétitions confondues, donc un candidat peut très bien venir d'un autre
// championnat que celui recherché (cas réel : "Karlsruhe" en 2. Bundesliga
// apparié à "Sankt Pauli II" en Regionalliga — simple hasard de score de
// similarité, pas le même match). Vérifier date puis ligue AVANT les noms
// évite justement de suivre une suggestion d'alias qui casserait plus
// qu'elle ne corrigerait.
function classifierUnmatched(t) {
  if (typeof t === "string") return "string";     // anciennes données (donnees.js pas régénéré)
  if (t.candidat === null) return "none";          // aucun candidat, trou de couverture pur
  return t.ligue_ok ? "ligue_ok" : "ligue_ko";
}

function renderUnmatchedItem(t) {
  if (typeof t === "string") return `<li>${t}</li>`;
  let suffix = "";
  let suggestion = null;
  if (t.candidat) {
    const checks =
      `<span class="match-check ok" title="Le candidat vient du même jour (toujours vrai : la recherche ne regarde jamais un autre jour).">✓ même date</span>` +
      (t.ligue_ok
        ? `<span class="match-check ok" title="Pays/ligue alignés entre cotes et résultats.">✓ même ligue</span>`
        : `<span class="match-check warn" title="Côté résultats : ${t.candidat_pays} · ${t.candidat_ligue} — différent de ${t.pays} · ${t.ligue}. Probablement un trou de couverture (aucun match de cette ligue ce jour-là) plutôt qu'un nom mal rapproché : à vérifier avant de faire confiance au nom suggéré ci-dessous.">⚠ ligue différente</span>`);
    suffix = ` <br>${checks}<br><span class="muted">↳ candidat le plus proche (score ${t.score}) : ${t.candidat}</span>`;
    // La ligue doit être alignée pour proposer un alias : un candidat
    // d'une autre compétition n'est presque jamais le bon match (voir
    // l'exemple Karlsruhe/Sankt Pauli II ci-dessus) — générer un alias
    // dans ce cas casserait plus qu'il ne corrigerait.
    suggestion = t.ligue_ok ? suggestionAliasEquipes(t) : null;
  } else if (t.candidat === null) {
    suffix = ` <br><span class="muted">↳ aucun résultat ce jour-là (trou de couverture, pas un nom mal rapproché)</span>`;
  }
  // Bouton de génération : n'apparaît que si au moins une ligne d'alias a
  // vraiment quelque chose à proposer (deux noms déjà identiques une fois
  // normalisés n'ont rien à corriger, même avec un candidat affiché).
  let copyBtn = "";
  if (suggestion) {
    copyBtn = ` <button type="button" class="btn-copy-alias" title="${suggestion.replace(/"/g,'&quot;')}"
      data-alias="${encodeURIComponent(suggestion)}">Copier l'entrée Python</button>`;
  }
  return `<li><strong>${t.match}</strong> <span class="muted">— ${t.pays} · ${t.ligue} · ${t.date}</span>${suffix}${copyBtn}</li>`;
}

(function initUnmatched() {
  const box = $("unmatchedBox"), list = $("unmatchedList");
  if (!UNMATCHED.length) { box.style.display="none"; return; }
  // Panneau affichant désormais l'ensemble des matchs non rapprochés (plus
  // de plafond à 80 côté Python depuis le 25/09/2026) : totalReel et
  // UNMATCHED.length coïncident toujours, mais le test reste en place par
  // sécurité si un plafond était un jour réintroduit.
  const totalReel = (WIZARD_DATA.meta || {}).unmatched;
  box.querySelector("summary").textContent =
    (totalReel != null && totalReel > UNMATCHED.length
      ? `${totalReel} match(s) non rapproché(s) (${UNMATCHED.length} affiché(s) ci-dessous)`
      : `${UNMATCHED.length} match(s) non rapproché(s)`)
    + " — cliquer pour voir";

  const select = $("unmatchedFilter"), countEl = $("unmatchedFilterCount");
  function rerender() {
    const filtre = select.value;
    const visibles = filtre === "all" ? UNMATCHED : UNMATCHED.filter(t => classifierUnmatched(t) === filtre);
    list.innerHTML = visibles.map(renderUnmatchedItem).join("");
    countEl.textContent = filtre === "all" ? "" : `${visibles.length} / ${UNMATCHED.length} affiché(s)`;
  }
  select.addEventListener("change", rerender);
  rerender();
})();

(function initLiguesNonAlignees() {
  const box = $("unalignedLeaguesBox"), list = $("unalignedLeaguesList");
  if (!box || !list) return;
  // Fusionne les deux diagnostics (backtest + value bets) qui peuvent
  // chacun rencontrer des matchs de la même ligue non alignée — voir le
  // commentaire de ligues_non_alignees côté Python (wina_wizard.py).
  const compte = new Map();
  const ajouter = src => (src || []).forEach(([cle, n]) => compte.set(cle, (compte.get(cle) || 0) + n));
  ajouter((WIZARD_DATA.dc_stats || {}).ligues_non_alignees);
  ajouter((WIZARD_DATA.poisson_stats || {}).ligues_non_alignees);
  const lignes = [...compte.entries()].sort((a, b) => b[1] - a[1]);
  if (!lignes.length) { box.style.display = "none"; return; }
  const total = lignes.reduce((s, [, n]) => s + n, 0);
  box.querySelector("summary").textContent =
    `${lignes.length} compétition(s) non alignée(s), ${total} match(s) perdu(s) — cliquer pour voir`;
  // ligues_non_alignees_detail (ajout du 20/09/2026) donne, pour chaque
  // ligue non alignée, le libellé pays/ligue RÉEL côté résultats — retrouvé
  // via le rapprochement par nom d'équipe (indépendant de l'alignement de
  // ligue), donc fiable même quand ce dernier échoue. Seul dc_stats le
  // fournit (voir le commentaire Python) ; on fusionne les deux sources par
  // clé au cas où poisson_stats en gagnerait un jour.
  const detail = new Map();
  const ajouterDetail = src => (src || []).forEach(d => { if (d.candidat && !detail.has(d.cle)) detail.set(d.cle, d.candidat); });
  ajouterDetail((WIZARD_DATA.dc_stats || {}).ligues_non_alignees_detail);
  ajouterDetail((WIZARD_DATA.poisson_stats || {}).ligues_non_alignees_detail);
  list.innerHTML = lignes.map(([cle, n]) => {
    const candidat = detail.get(cle);
    let suffix = "", copyBtn = "";
    if (candidat) {
      suffix = ` <br><span class="muted">↳ côté résultats, cette compétition s'appelle : ${candidat}</span>`;
      const suggestion = suggestionAliasLigue(cle, candidat);
      if (suggestion) {
        copyBtn = ` <button type="button" class="btn-copy-alias" title="${suggestion.replace(/"/g,'&quot;')}"
          data-alias="${encodeURIComponent(suggestion)}">Copier l'entrée Python</button>`;
      }
    }
    return `<li><strong>${cle}</strong> <span class="muted">— ${n} match(s)</span>${suffix}${copyBtn}</li>`;
  }).join("");
})();

/* ================= PAGE 2 — DIXON-COLES ================= */
let vSortKey = "ev", vSortDir = -1;
function vFilters() { return { cat:$("vCat").value, edge:parseFloat($("vEdge").value), search:$("vSearch").value.trim().toLowerCase() }; }
function vFiltered() {
  const f = vFilters();
  return VALUE_BETS.filter(v => (!f.cat||v.categorie===f.cat) && (v.edge>=f.edge) && (!f.search||v.match.toLowerCase().includes(f.search)));
}
function renderValueBets() {
  const stake = parseFloat($("vStake").value) || 0;
  let rows = vFiltered().slice().sort((a,b) => {
    let va=a[vSortKey], vb=b[vSortKey];
    if (va<vb) return -vSortDir; if (va>vb) return vSortDir; return 0;
  });
  const n = rows.length, mise = n*stake;
  let evTotal=0, edgeSum=0;
  rows.forEach(v => { evTotal += v.ev*stake; edgeSum += v.edge; });
  $("vNb").textContent = n;
  $("vMise").textContent = mise.toLocaleString("fr-FR") + " €";
  const evEl=$("vEv"); evEl.textContent=fmtEur(evTotal); evEl.className="v "+(evTotal>=0?"pos":"neg");
  $("vEdgeAvg").textContent = n>0 ? fmtPct(edgeSum/n) : "—";
  $("vBody").innerHTML = rows.slice(0,400).map(v => `
    <tr>
      <td data-label="Espérance" class="num ${v.ev>=0?'pos':'neg'}"><strong>${fmtPct(v.ev)}</strong></td>
      <td data-label="Date">${v.date}</td><td data-label="Match">${v.match}</td><td data-label="Ligue"><span class="pill">${ligueLabel(v.pays, v.ligue)}</span></td>
      <td data-label="Pari">${v.colonne}</td><td data-label="Cote" class="num">${v.cote.toFixed(2)}</td>
      <td data-label="Proba modèle" class="num">${(v.p_model*100).toFixed(1)} %</td>
      <td data-label="Proba cote" class="num muted">${(v.p_implied*100).toFixed(1)} %</td>
      <td data-label="Edge" class="num pos">${fmtPct(v.edge)}</td>
    </tr>`).join("") || `<tr><td colspan="9" class="muted">Aucun value bet avec ces filtres${VALUE_BETS.length? "." : " (historique encore insuffisant)."}</td></tr>`;
  $("vRowInfo").textContent = `${n} value bet(s)` + (n>400?" (400 affichés)":"");
}
["vStake","vCat","vEdge","vSearch"].forEach(id => {
  const el=$(id); el.addEventListener("input", renderValueBets); el.addEventListener("change", renderValueBets);
});
document.querySelectorAll("#vTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.vk;
    if (vSortKey===k) vSortDir*=-1; else { vSortKey=k; vSortDir=(k==="ev"||k==="edge"||k==="p_model")?-1:1; }
    renderValueBets();
  });
});

/* ================= PAGE 3 — PARIS À VENIR ================= */
const UPCOMING = VALUE_BETS.filter(v => v.is_upcoming && v.days_until!=null && v.days_until <= UPCOMING_DAYS);
// Le badge sur l'onglet est mis à jour dans renderUpcoming() (voir plus
// bas, juste à côté de $("uNb")) : il doit refléter le nombre de cartes
// RÉELLEMENT affichées compte tenu des filtres actifs, pas un total figé
// calculé une seule fois au chargement — sans quoi le chiffre de l'onglet
// pouvait ne plus correspondre du tout à ce qu'il y avait en dessous.

/* --- Suivi des paris réellement joués ---------------------------------
   L'identifiant doit rester stable d'un jour à l'autre (les cotes bougent,
   l'ordre change), donc il est construit sur ce qui ne change pas :
   date + match + pari. Les paris cochés sont mémorisés dans WIZARD_DATA
   (fichier paris_joues.json relu par wina_wizard.py à chaque génération),
   ce qui les fait survivre aux regénérations quotidiennes.

   PLACED est une Map clé -> {mise}, pas un simple Set : sans la mise
   réellement engagée, impossible de calculer une vraie évolution de
   bankroll (page "Bankroll" plus bas) — on ne saurait que QUELS paris ont
   été joués, pas COMBIEN. */
// Object.entries suffit pour le format normal {"clé": {"mise": N}}, mais
// d'anciens fichiers peuvent contenir deux formes dégradées :
//   - une LISTE de paires [clé, {"mise": N}] (bouton « Télécharger »
//     d'avant correction, qui sérialisait la Map avec [...PLACED]) ;
//   - une clé DÉJÀ figée en chaîne par une ancienne version Python :
//     "['2026-09-12|Match|homeWin', {'mise': 6}]".
// Les deux sont rattrapées ici, mise comprise, plutôt que de s'afficher
// telles quelles avec 0 € dans la page Bankroll.
function reparerClePlacee(cle, valeur) {
  const mise = (valeur && valeur.mise != null) ? valeur.mise : null;
  const s = String(cle);
  if (!(s.startsWith("[") && s.endsWith("]"))) return [s, {mise}];
  // Représentation Python : guillemets simples, et rien d'autre à exécuter.
  // On extrait la vraie clé et la mise par lecture directe, sans eval.
  const mCle = s.match(/^\['([^']*)'/);
  const mMise = s.match(/'mise'\s*:\s*([\d.]+)/);
  if (!mCle) return [s, {mise}];
  return [mCle[1], {mise: mMise ? parseFloat(mMise[1]) : mise}];
}

const PLACED = new Map(
  (Array.isArray(WIZARD_DATA.paris_joues)
    ? WIZARD_DATA.paris_joues.map(x =>
        Array.isArray(x) && x.length === 2 ? [x[0], x[1]] : [x, null])
    : Object.entries(WIZARD_DATA.paris_joues || {})
  ).map(([k, v]) => reparerClePlacee(k, v))
);

// --- Filet de sécurité local : le fichier paris_joues.json ci-dessus n'est
// mis à jour QUE quand vous téléchargez/copiez l'export et remplacez le
// fichier sur le disque avant de relancer wina_wizard.py. Si vous cochez
// des paris puis relancez le script sans avoir fait cet export, la page
// régénérée repart de l'ancien fichier et ces coches disparaissent — c'est
// le bug qu'on corrige ici.
//
// Le navigateur retient donc lui aussi, dans localStorage, un instantané
// de chaque clé jamais touchée dans CE navigateur : {mise} si cochée,
// `null` si décochée (un "tombstone" — sinon un simple retrait de la Map
// ne suffirait pas à empêcher le fichier disque, resté périmé, de la faire
// réapparaître). Au chargement, on part du fichier disque (source
// "officielle", partageable) et on rejoue par-dessus l'historique local :
// ça comble les coches jamais exportées, sans jamais rien perdre du fichier.
// localStorage est isolé par origine ET par chemin de fichier — tant que
// vous rouvrez ce même index.html (même dossier), l'historique suit.
const PLACED_LS_KEY = "wina_placed_overrides_v1";

function chargerOverridesLocaux() {
  try {
    const brut = localStorage.getItem(PLACED_LS_KEY);
    if (!brut) return {};
    const parsed = JSON.parse(brut);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Objet mutable {clé: {mise} | null} — persisté tel quel à chaque
// changement. C'est la mémoire longue de ce navigateur, distincte de
// PLACED (qui ne connaît que l'état ACTUEL, pas les retraits).
const LOCAL_OVERRIDES = chargerOverridesLocaux();

// Rejoue les overrides locaux par-dessus la Map issue du disque.
Object.entries(LOCAL_OVERRIDES).forEach(([cle, valeur]) => {
  if (valeur) PLACED.set(cle, valeur);
  else PLACED.delete(cle);
});

function sauverOverridesLocaux() {
  try {
    localStorage.setItem(PLACED_LS_KEY, JSON.stringify(LOCAL_OVERRIDES));
  } catch (e) {
    // Navigation privée, quota dépassé, storage désactivé… tant pis,
    // le fichier paris_joues.json (export manuel) reste le filet de secours.
  }
}

function betKey(v) {
  return `${v.date}|${v.match}|${v.colonne}`;
}

function togglePlaced(key, on, mise) {
  if (on) PLACED.set(key, {mise: mise != null ? mise : (PLACED.get(key)?.mise ?? null)});
  else PLACED.delete(key);
  // Trace locale : {mise} si coché, `null` si décoché (tombstone) — voir
  // le commentaire au-dessus de LOCAL_OVERRIDES. Persisté immédiatement,
  // pas seulement au rechargement, pour survivre à un crash/fermeture
  // d'onglet entre la coche et la prochaine régénération.
  LOCAL_OVERRIDES[key] = on ? PLACED.get(key) : null;
  sauverOverridesLocaux();
  updatePlacedSummary();
  renderPlacedExport();
  // La page Bankroll n'est pas forcément visible au moment du clic (les
  // pages sont toutes pré-rendues, seule la visibilité CSS change au clic
  // d'onglet) : la retenir à jour dès maintenant évite qu'elle affiche du
  // périmé la prochaine fois qu'on y bascule.
  if (typeof renderBankroll === "function") renderBankroll();
}

function updatePlacedSummary() {
  const el = $("uPlacedCount");
  if (!el) return;
  const n = PLACED.size;
  el.textContent = n;
  // Somme des VRAIES mises saisies, pas un nombre de paris × une mise
  // théorique unique — deux paris joués peuvent avoir des montants
  // différents, notamment si vous ajustez selon le nombre de paris du jour
  // (cf. page Bankroll). Un simple montant, pas fmtEur (qui préfixe "+" —
  // pertinent pour un gain/perte, pas pour un total misé).
  const total = [...PLACED.values()].reduce((s, p) => s + (p.mise || 0), 0);
  const box = $("placedBox");
  if (box) box.style.display = n > 0 ? "" : "none";
  const tot = $("uPlacedTotal");
  if (tot) tot.textContent = total.toLocaleString("fr-FR", {maximumFractionDigits: 2}) + " €";
}

function renderPlacedExport() {
  const ta = $("placedExport");
  if (!ta) return;
  ta.value = JSON.stringify(Object.fromEntries(PLACED), null, 1);
}

function fmtKickoff(iso) {
  // "2026-03-05T20:00:00" -> "05/03 à 20:00"
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
  if (!m) return String(iso).slice(0,10);
  const [_,Y,Mo,D,h,mi] = m;
  return `${D}/${Mo}` + (h ? ` à ${h}:${mi||"00"}` : "");
}

function renderUpcoming() {
  const stake = parseFloat($("uStake").value) || 0;
  // Kelly raisonne en fraction de bankroll : on prend celle saisie sur la
  // page Bankroll, a defaut 100 EUR pour que l'ordre de grandeur reste lisible.
  const strategieMise = $("uMise2") ? $("uMise2").value : "fixe";
  const bankrollRef = parseFloat(($("bkDepart") || {}).value) || 100;
  const cats = categoriesCochees("u");
  const edge = parseFloat($("uEdge").value), sortBy = $("uSort").value;
  const ligues = liguesCochees("u");
  const pred = $("uPred") ? $("uPred").value : "";
  const devig = $("uDevig") ? $("uDevig").value === "1" : false;
  const alpha = blendAlpha("uAlpha");

  // ENRICHISSEMENT xG — même substitution centralisée que btFiltered() sur
  // la page DC rétrospectif : les champs p_model/edge/edge_devig/ev/
  // lam_home/lam_away de la source portent déjà la bonne valeur pour le
  // mode actif, tout le reste de la fonction continue de les lire sans
  // rien savoir du mode. Les matchs sans historique xG suffisant sont
  // EXCLUS en mode "avec", jamais comblés par la valeur en buts déguisée.
  const modeXg = $("uEnrichi") ? $("uEnrichi").value : "sans";
  // Correction de calibration appliquée à l'ensemble AVANT la substitution
  // xG — même ordre que sur la page DC rétrospectif, pour que les deux
  // pages restent strictement comparables quand leurs filtres sont liés.
  const calibActif = $("uCalib") ? $("uCalib").value === "1" : false;
  // Binomiale négative : même bascule et même exclusivité avec l'xG que
  // sur "DC rétrospectif" (voir btFiltered/appliquerNb).
  const nbActif = $("uLoi") && $("uLoi").value === "nbinom" && modeXg === "sans";
  let source = appliquerXg(appliquerNb(calibrer(UPCOMING, calibActif), nbActif), modeXg);

  // Chaque pari reçoit ses valeurs recalculées selon le mode choisi, pour
  // que l'affichage (edge, espérance) corresponde bien au filtre appliqué.
  let rows = source.map(v => {
    if (alpha < 1) {
      const bl = blended(v, alpha);
      return Object.assign({}, v, {edge_aff: bl.edge, ev_aff: bl.ev, p_aff: bl.p});
    }
    const e = devig ? (v.edge_devig ?? v.edge) : v.edge;
    return Object.assign({}, v, {edge_aff: e, ev_aff: v.ev, p_aff: v.p_model});
  }).filter(v => {
    if (cats && !cats.includes(v.categorie)) return false;
    if (ligues && !ligues.has(ligueKey(v.pays, v.ligue))) return false;
    if (v.edge_aff < edge) return false;
    if (!dansPlageCote(v.cote, $("uCote") ? $("uCote").value : "")) return false;
    // Espérance : un edge dévigué positif ne garantit PAS une espérance
    // positive — sur une cote très basse, la marge du bookmaker peut
    // dépasser l'avantage du modèle (ex. cote 1.03 à 91 % : edge +2,5 %
    // mais espérance -6,3 %). ev_aff porte déjà la valeur du mode actif
    // (mélangée si α < 1), donc le filtre suit ce qui est affiché.
    // Seuil d'esperance : -999 = pas de filtre, 0 = strictement positive,
    // puis des paliers (0.02 = au moins +2 % de la mise).
    if ($("uEvPos")) {
      const seuilEv = parseFloat($("uEvPos").value);
      if (seuilEv > -900) {
        const ev = v.ev_aff ?? v.ev;
        if (ev == null) return false;
        // "Positive" exclut le zero ; les paliers sont inclusifs.
        if (seuilEv === 0 ? ev <= 0 : ev < seuilEv) return false;
      }
    }
    // Plafond d'espérance : au-delà, l'espérance affichée n'est presque
    // jamais une vraie opportunité mais une erreur du modèle (voir le
    // commentaire détaillé sur seuilEvMax dans btFiltered, page DC
    // rétrospectif — même mesure empirique, même seuil par défaut).
    // 999 = pas de plafond ; une espérance manquante n'est jamais exclue.
    if ($("uEvMax")) {
      const seuilEvMax = parseFloat($("uEvMax").value);
      if (seuilEvMax < 900) {
        const ev = v.ev_aff ?? v.ev;
        if (ev != null && ev > seuilEvMax) return false;
      }
    }
    // Marchés de queue / plafond d'edge dévigué — même logique et même
    // portée (Intervalle de buts / Plus-Moins de buts uniquement) que sur
    // la page DC rétrospectif (btFiltered) ; voir le commentaire détaillé
    // sur MARCHES_QUEUE en tête de fichier.
    if (CATEGORIES_FILTRE_QUEUE.has(v.categorie)) {
      if ($("uFiltreQueue") && $("uFiltreQueue").value === "1" && MARCHES_QUEUE.has(v.colonne)) return false;
      if ($("uEdgeDevigMax")) {
        const seuilEdgeDevigMax = parseFloat($("uEdgeDevigMax").value);
        if (seuilEdgeDevigMax < 900 && v.edge_aff != null && v.edge_aff > seuilEdgeDevigMax) return false;
      }
    }
    if (pred === "accord" && v.prediction_accord !== "accord") return false;
    if (pred === "desaccord" && v.prediction_accord !== "desaccord") return false;
    if (pred === "neutre" && !(v.prediction && !v.prediction_accord)) return false;
    // Même logique que la page DC rétrospectif (btFiltered) : les six
    // niveaux de mouvement de cote, pas seulement les deux premiers.
    const mv = $("uMvt") ? $("uMvt").value : "";
    if (mv) {
      const variation = v.variation_proba || 0;   // > 0 = la cote a raccourci
      if (mv === "racc" && !v.raccourcit) return false;
      if (mv === "racc_fort" && variation < 0.02) return false;
      // Corrigé comme btFiltered (voir son commentaire) : on teste la
      // variation elle-même, pas le booléen "a raccourci", pour ne garder
      // que des allongements réels et non les cotes restées stables.
      if (mv === "allonge" && variation > -0.0001) return false;
      if (mv === "allonge_fort" && variation > -0.02) return false;
      if (mv === "stable" && Math.abs(variation) >= 0.01) return false;
      // Écarte les paris dont la cote s'allonge : mesuré à -53 % de ROI sur
      // les données réelles, contre -5 % pour celles qui raccourcissent.
      if (mv === "sauf_allonge" && variation < -0.0001) return false;
      if (mv === "sauf_allonge_fort" && variation <= -0.02) return false;
    }
    return true;
  });

  // --- Repérage des paris LIÉS, et "Un seul par match" ------------------
  // Plusieurs seuils Plus/Moins sur le même match ne sont PAS des paris
  // indépendants : ils sont emboîtés (si "Moins de 2.5" gagne, "Moins de
  // 3.5" gagne forcément aussi). Les jouer tous revient à tripler la mise
  // sur une seule hypothèse, pas à diversifier. On les repère pour que
  // l'utilisateur le voie (badge), et pour pouvoir les cacher si le filtre
  // "Paris liés" est actif — calculé AVANT le tri et les totaux KPI, pour
  // que "Total à miser"/"Espérance totale" reflètent bien ce qui est
  // réellement affiché, pas l'ensemble avant dédoublonnage.
  const groupes = {};
  rows.forEach(v => {
    const k = `${v.match}|${v.categorie}`;
    (groupes[k] = groupes[k] || []).push(v);
  });
  const meilleurDuGroupe = {};   // clé de groupe -> pari à retenir
  Object.entries(groupes).forEach(([k, arr]) => {
    if (arr.length > 1) {
      meilleurDuGroupe[k] = arr.reduce((a, b) => ((b.ev_aff ?? b.ev) > (a.ev_aff ?? a.ev) ? b : a));
    }
  });
  const dedupActif = $("uDedup") ? $("uDedup").value === "1" : false;
  if (dedupActif) {
    rows = rows.filter(v => {
      const k = `${v.match}|${v.categorie}`;
      return (groupes[k] || []).length <= 1 || meilleurDuGroupe[k] === v;
    });
  }

  rows.sort((a,b) => {
    if (sortBy==="kickoff") return String(a.kickoff).localeCompare(String(b.kickoff));
    // Trie sur les valeurs AFFICHÉES (mélangées si α<1), sinon l'ordre
    // contredirait les chiffres visibles sur les cartes.
    if (sortBy==="ev") return b.ev_aff - a.ev_aff;
    if (sortBy==="edge") return b.edge_aff - a.edge_aff;
    return b[sortBy]-a[sortBy];
  });
  const n = rows.length;
  // Mise reellement engagee par pari : la mise fixe saisie, ou la mise
  // conseillee par Kelly (variable selon l'edge et la cote de CHAQUE pari).
  // Avant ce calcul, "Total a miser"/"Esperance totale" restaient bases sur
  // la mise fixe meme quand Kelly etait choisi dans "Strategie de mise" —
  // rien ne changeait donc a l'ecran en dehors d'une petite ligne sur
  // chaque carte, facile a manquer. Les deux totaux suivent desormais
  // vraiment la strategie choisie.
  const miseParPari = strategieMise === "fixe"
    ? rows.map(() => stake)
    : rows.map(v => miseConseillee(v, "uMise2", stake, bankrollRef));
  const mise = miseParPari.reduce((s,m) => s+m, 0);
  const evTotal = rows.reduce((s,v,i) => s+(v.ev_aff ?? v.ev)*miseParPari[i], 0);
  const matches = new Set(rows.map(v=>v.match)).size;
  $("uNb").textContent = n;
  // Même chiffre que "uNb" ci-dessus, dupliqué sur le badge de l'onglet :
  // toujours égal au nombre de cartes réellement affichées dans la grille
  // plus bas (rows.map(...) sans aucune pagination), quels que soient les
  // filtres actifs — jamais un total indépendant qui pourrait diverger.
  const tabCount = $("tabUpCount");
  if (tabCount) tabCount.textContent = n;
  $("uMise").textContent = mise.toLocaleString("fr-FR", {maximumFractionDigits: 0}) + " €";
  const evEl=$("uEv"); evEl.textContent=fmtEur(evTotal); evEl.className="v "+(evTotal>=0?"pos":"neg");
  $("uMatches").textContent = matches;

  // Rend le changement de strategie tangible : avec Kelly, "Total a miser"
  // varie desormais reellement (mise moyenne differente de la mise fixe,
  // et cet ecart se voit d'un coup d'oeil dans le KPI ci-dessus).
  const uMiseNote = $("uMiseNote");
  if (uMiseNote) {
    if (strategieMise === "fixe" || n === 0) {
      uMiseNote.style.display = "none";
    } else {
      const moyenne = mise / n;
      uMiseNote.style.display = "";
      uMiseNote.innerHTML = `<strong>Mise Kelly active</strong> — chaque pari reçoit sa propre mise `
        + `(proportionnelle à son edge et à sa cote), au lieu de ${stake.toFixed(2)} € pour tous. `
        + `Mise moyenne ici : <strong>${moyenne.toFixed(2)} €</strong> `
        + `(${(moyenne/bankrollRef*100).toFixed(1)} % de la bankroll de ${bankrollRef.toFixed(0)} €). `
        + `« Total à miser » et « Espérance totale » ci-dessus intègrent déjà cette variation — `
        + `le détail par pari reste visible sur chaque carte.`;
    }
  }

  // Transparence sur ce que le mode xG fait vraiment à l'échantillon :
  // "avec" ÉCARTE les matchs sans historique xG, "auto" les conserve avec
  // le modèle en buts. Sans cette note, la chute du nombre de paris en
  // mode "avec" passerait pour une baisse de recommandations alors qu'il
  // s'agit d'une baisse de couverture xG.
  const uEnrichiNote = $("uEnrichiNote");
  if (uEnrichiNote) {
    if (modeXg === "sans") {
      uEnrichiNote.style.display = "none";
    } else {
      const avecXg = UPCOMING.filter(v => v.p_model_xg != null).length;
      uEnrichiNote.style.display = "";
      uEnrichiNote.innerHTML = modeXg === "auto"
        ? `<strong>Mode « xG si disponible »</strong> — ${n} pari(s) affiché(s). `
          + `${avecXg} des ${UPCOMING.length} paris à venir utilisent l'xG ; `
          + `les autres gardent le modèle en buts, aucun n'est écarté.`
        : `<strong>Mode « uniquement les matchs à xG »</strong> — ${n} pari(s) affiché(s), `
          + `parmi ${avecXg} paris à xG sur ${UPCOMING.length} au total. Les `
          + `${UPCOMING.length - avecXg} autres sont écartés faute d'historique xG `
          + `suffisant des deux côtés.`;
    }
  }

  majLoiNote("u");

  const grid = $("recGrid"), empty = $("uEmpty");
  if (n===0) {
    grid.innerHTML = "";
    empty.style.display = "block";
    empty.textContent = UPCOMING.length===0
      ? `Aucun match à venir dans les ${UPCOMING_DAYS} prochains jours n'a de value bet (ou l'historique est encore insuffisant). Reviens quand de nouvelles cotes auront été capturées.`
      : "Aucune recommandation ne correspond à ces filtres. Baisse l'edge minimum ou change de catégorie.";
    return;
  }
  empty.style.display = "none";

  grid.innerHTML = rows.map(v => {
    const groupeKey = `${v.match}|${v.categorie}`;
    const groupeTaille = (groupes[groupeKey] || []).length;
    const estLie = groupeTaille > 1;
    const estMeilleur = estLie && meilleurDuGroupe[groupeKey] === v;
    // Bloc absences : n'apparaît que si l'enrichissement API-Football a
    // fourni des données pour ce match.
    let injuryBlock = "";
    if (v.n_absences !== undefined) {
      const nMatch = v.n_absences_match || 0;
      if (nMatch > 0) {
        // Triées par importance décroissante : l'absence la plus lourde de
        // conséquence apparaît en premier, pas dans un ordre arbitraire.
        // Les joueurs mis en évidence (importance > 0.5, soit un titulaire
        // régulier ou un contributeur offensif notable) ressortent en gras.
        const absents = (v.absences || [])
          .filter(a => String(a.type||"").toLowerCase().includes("missing"))
          .filter(a => a.joueur)
          .sort((a,b) => (b.importance ?? -1) - (a.importance ?? -1))
          .slice(0, 4);
        const noms = absents.map(a =>
          (a.importance != null && a.importance > 0.5) ? `<strong>${a.joueur}</strong>` : a.joueur);
        const reste = nMatch - noms.length;
        injuryBlock = `
          <div class="rec-injuries">
            <span class="inj-dot" aria-hidden="true"></span>
            <span><strong>${nMatch} absent${nMatch>1?'s':''}</strong>${noms.length? " · " + noms.join(", ") : ""}${reste>0? ` +${reste}` : ""}
            ${v.penalite_absences ? `<span class="inj-adj">espérance réduite de ${(v.penalite_absences*100).toFixed(0)} %</span>` : ""}</span>
          </div>`;
      } else {
        injuryBlock = `<div class="rec-injuries ok"><span class="inj-dot ok" aria-hidden="true"></span><span>Aucune absence signalée</span></div>`;
      }
    }

    // Prévision indépendante d'API-Football : un badge visible d'un coup
    // d'œil (confirme / diverge / avis neutre), le détail complet
    // apparaissant au survol via attachPredTooltips(). Absent si aucune
    // prévision n'a été collectée pour ce match — jamais un badge vide.
    let predBlock = "";
    if (v.prediction) {
      const acc = v.prediction_accord;
      const classe = acc === "accord" ? "pos" : (acc === "desaccord" ? "neg" : "neutral");
      // ✓/✗ s'affichent partout de façon fiable ; le cas neutre utilise un
      // badge dessiné en CSS (pred-icon-i) plutôt que le caractère "ⓘ",
      // absent de certaines polices et qui s'affichait cassé.
      const icone = acc === "accord" ? '<span class="pred-icon" aria-hidden="true">✓</span>'
                   : acc === "desaccord" ? '<span class="pred-icon" aria-hidden="true">✗</span>'
                   : '<span class="pred-icon-i" aria-hidden="true">i</span>';
      const libelle = acc === "accord" ? "Confirme le pari"
                     : (acc === "desaccord" ? "Avis divergent" : "Second avis (API)");
      const payload = encodeURIComponent(JSON.stringify({
        m: v.match, vq: v.prediction.vainqueur_annonce,
        pd: v.prediction.pct_domicile, pn: v.prediction.pct_nul, pe: v.prediction.pct_exterieur,
        co: v.prediction.conseil, pm: v.prediction.plus_moins, ac: acc,
      }));
      predBlock = `
        <div class="rec-pred ${classe}" data-pred="${payload}">
          ${icone}
          <span><strong>${libelle}</strong> <span class="muted">— prévision API-Football</span></span>
        </div>`;
    }

    // Consensus de marché (plusieurs bookmakers) : purement informatif,
    // n'entre à aucun moment dans le calcul d'edge du modèle. Seuil de
    // ±3% pour distinguer un écart notable d'un simple bruit entre
    // bookmakers — arbitraire mais raisonnable pour une première version.
    let marcheBlock = "";
    if (v.marche_mediane != null) {
      const ecart = v.marche_ecart_pct;
      const classeM = ecart >= 3 ? "pos" : (ecart <= -3 ? "neg" : "neutral");
      const libelleM = ecart >= 3 ? "Cote au-dessus du marché"
                      : (ecart <= -3 ? "Cote en retrait du marché" : "Cote alignée sur le marché");
      const iconeM = ecart >= 3 ? '<span class="pred-icon" aria-hidden="true">✓</span>'
                    : (ecart <= -3 ? '<span class="pred-icon" aria-hidden="true">✗</span>'
                                    : '<span class="pred-icon-i" aria-hidden="true">i</span>');
      marcheBlock = `
        <div class="rec-pred ${classeM}" title="Médiane de ${v.marche_n_bookmakers} bookmaker(s) : ${v.marche_mediane.toFixed(2)} — Winamax : ${v.cote.toFixed(2)}">
          ${iconeM}
          <span><strong>${libelleM}</strong> <span class="muted">(${ecart>=0?"+":""}${ecart.toFixed(1)}% vs ${v.marche_n_bookmakers} bookmakers)</span></span>
        </div>`;
    }
    // Mise conseillee : null en mode "Montant fixe", puisque la valeur
    // serait la meme pour tous les paris et n'apporterait rien.
    const miseKelly = (strategieMise !== "fixe")
      ? miseConseillee(v, "uMise2", stake, bankrollRef) : null;
    const key = betKey(v);
    const isPlaced = PLACED.has(key);
    const miseActuelle = PLACED.get(key)?.mise;
    const classesLien = estLie ? (estMeilleur ? " lie-best" : " lie-alt") : "";
    // Une fois le pari joué, ce statut prime : le conseil sur les seuils
    // liés n'a plus d'utilité, on affiche le marqueur "joué" à la place.
    let badgeLien = `<div class="rec-linked empty">&nbsp;</div>`;
    if (isPlaced) {
      badgeLien = `<div class="rec-linked played-mark">✓ Pari joué</div>`;
    } else if (estLie) {
      badgeLien = `<div class="rec-linked${estMeilleur ? " best" : ""}">
           ${estMeilleur
             ? `Meilleure espérance des ${groupeTaille} seuils de ce match`
             : `Lié · ${groupeTaille} seuils sur ce match, un seul à jouer`}
         </div>`;
    }
    return `
    <div class="rec${isPlaced ? ' placed' : ''}${classesLien}" data-key="${key.replace(/"/g, '&quot;')}">
      ${badgeLien}
      <div class="rec-top">
        <div class="rec-match">${v.match}${v.match_id ? ` <a href="https://www.winamax.fr/paris-sportifs/match/${v.match_id}" target="_blank" rel="noopener" class="rec-winamax-link" title="Parier sur ce match (Winamax)">↗</a>` : ""}</div>
        <div class="rec-when">${fmtKickoff(v.kickoff)}</div>
      </div>
      <div class="rec-league">${ligueLabel(v.pays, v.ligue)} · <span class="tag-cat">${v.categorie}</span>
        ${catBadgeHtml(v.categorie)}</div>
      <div class="rec-bet">
        <span class="rec-pill">${v.colonne}</span>
        <span class="muted">à la cote</span> <strong style="font-family:var(--mono)">${v.cote.toFixed(2)}</strong>
      </div>
      <div class="rec-metrics">
        <div class="rec-metric"><div class="mk">Proba retenue</div><div class="mv">${((v.p_aff ?? v.p_model)*100).toFixed(0)} %</div></div>
        <div class="rec-metric"><div class="mk">Edge</div><div class="mv pos">${fmtPct(v.edge_aff ?? v.edge)}</div></div>
        <div class="rec-metric"><div class="mk">Espérance</div><div class="mv ${(v.ev_aff ?? v.ev)>=0?'pos':'neg'}">${fmtPct(v.ev_aff ?? v.ev)}</div></div>
      </div>
      ${miseKelly != null ? `<div class="rec-kelly">Mise conseillée <strong>${miseKelly.toFixed(2)} €</strong>
        <span class="muted">(${(miseKelly/bankrollRef*100).toFixed(1)} % de ${bankrollRef.toFixed(0)} €)</span></div>` : ""}
      ${injuryBlock}
      ${predBlock}
      ${marcheBlock}
      ${(v.variation_proba != null && v.variation_proba < -0.0001) ? `
        <div class="rec-injuries">
          <span class="inj-dot" aria-hidden="true"></span>
          <span><strong>La cote s'allonge</strong> (${v.cote_ouverture} → ${v.cote.toFixed(2)})
          <span class="inj-adj">le marché s'éloigne de ce pari — historiquement le plus mauvais signal</span></span>
        </div>` : (v.raccourcit ? `
        <div class="rec-injuries ok">
          <span class="inj-dot ok" aria-hidden="true"></span>
          <span><strong>La cote raccourcit</strong> (${v.cote_ouverture} → ${v.cote.toFixed(2)})
          <span class="inj-adj">le marché confirme</span></span>
        </div>` : "")}
      <label class="rec-check" title="Cocher si tu as réellement joué ce pari">
        <input type="checkbox" class="chk placedchk" ${isPlaced ? "checked" : ""}>
        <span>${isPlaced ? "Pari joué" : "Marquer comme joué"}</span>
        <span class="mise-placee-wrap" style="${isPlaced ? "" : "display:none"}">
          <input type="number" class="mise-placee" min="0" step="0.5"
                 value="${miseActuelle != null ? miseActuelle : (parseFloat($("uStake").value) || 5)}"
                 title="Montant réellement misé sur ce pari (€)">€
        </span>
      </label>
    </div>`;
  }).join("");

  // Écouteurs des cases "Pari joué"
  grid.querySelectorAll(".placedchk").forEach(chk => {
    chk.addEventListener("change", e => {
      const card = e.target.closest(".rec");
      const key = card.dataset.key;
      const miseWrap = e.target.closest("label").querySelector(".mise-placee-wrap");
      const miseInput = miseWrap ? miseWrap.querySelector(".mise-placee") : null;
      miseWrap.style.display = e.target.checked ? "" : "none";
      togglePlaced(key, e.target.checked, miseInput ? parseFloat(miseInput.value) || 0 : null);
      card.classList.toggle("placed", e.target.checked);
      const lbl = e.target.nextElementSibling;
      if (lbl) lbl.textContent = e.target.checked ? "Pari joué" : "Marquer comme joué";
      // Bascule le bandeau du haut : marqueur "joué" ou conseil sur les seuils
      const banner = card.querySelector(".rec-linked");
      if (banner) {
        if (e.target.checked) {
          banner.dataset.prev = banner.dataset.prev || banner.innerHTML;
          banner.dataset.prevClass = banner.dataset.prevClass || banner.className;
          banner.className = "rec-linked played-mark";
          banner.innerHTML = "✓ Pari joué";
        } else if (banner.dataset.prev) {
          banner.className = banner.dataset.prevClass;
          banner.innerHTML = banner.dataset.prev;
        }
      }
    });
  });
  // Écouteur séparé pour une modification du montant SANS décocher/recocher
  // (corriger une mise déjà saisie).
  grid.querySelectorAll(".mise-placee").forEach(inp => {
    inp.addEventListener("change", e => {
      const card = e.target.closest(".rec");
      const key = card.dataset.key;
      if (PLACED.has(key)) togglePlaced(key, true, parseFloat(e.target.value) || 0);
    });
  });
  updatePlacedSummary();
  renderPlacedExport();
  attachPredTooltips();
}

/* Infobulle de la prévision indépendante d'API-Football sur la page
   « Paris à venir » — même mécanisme que attachDcTooltips (élément
   partagé, positionnement qui évite les débords d'écran), simplement
   déclenché par le badge .rec-pred et un contenu propre aux prévisions. */
function attachPredTooltips() {
  let tip = document.getElementById("predTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "predTip";
    tip.className = "dc-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  document.querySelectorAll(".rec-pred").forEach(el => {
    el.addEventListener("mouseenter", () => {
      let d;
      try { d = JSON.parse(decodeURIComponent(el.dataset.pred)); } catch { return; }

      const lectureAccord = d.ac === "accord"
        ? '<strong class="pos">Confirme le pari retenu</strong>'
        : d.ac === "desaccord"
        ? '<strong class="neg">Diverge du pari retenu</strong>'
        : '<span class="muted">Marché non directement comparable</span>';

      tip.innerHTML = `
        <div class="dc-tip-head">${d.m}</div>
        <div class="dc-tip-row"><span>Vainqueur annoncé</span><strong>${d.vq ?? "—"}</strong></div>
        <div class="dc-tip-sep"></div>
        <div class="dc-tip-row"><span>% Domicile</span><strong>${d.pd ?? "—"}</strong></div>
        <div class="dc-tip-row"><span>% Nul</span><strong>${d.pn ?? "—"}</strong></div>
        <div class="dc-tip-row"><span>% Extérieur</span><strong>${d.pe ?? "—"}</strong></div>
        ${d.pm ? `<div class="dc-tip-row"><span>Plus/Moins</span><strong>${d.pm}</strong></div>` : ""}
        <div class="dc-tip-sep"></div>
        <div class="dc-tip-row" style="display:block"><span>Conseil de l'API</span><br><strong>${d.co ?? "—"}</strong></div>
        <div class="dc-tip-sep"></div>
        <div class="dc-tip-row">${lectureAccord}</div>
        <div class="dc-tip-note">Prévision propre à API-Football — un second avis, indépendant du modèle
          Dixon-Coles, mis à jour toutes les heures. Pas encore validée sur des résultats réels :
          à lire comme une information brute, pas comme une recommandation.</div>`;
      tip.hidden = false;

      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth || 260, th = tip.offsetHeight || 220;
      let left = r.left + window.scrollX;
      let top = r.bottom + window.scrollY + 8;
      if (left + tw > window.innerWidth - 12) left = window.innerWidth - tw - 12;
      if (r.bottom + th + 20 > window.innerHeight) top = r.top + window.scrollY - th - 8;
      tip.style.left = Math.max(8, left) + "px";
      tip.style.top = Math.max(8, top) + "px";
    });
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}
["uStake","uEdge","uSort","uDevig","uAlpha","uMvt","uPred","uEnrichi","uLoi","uDedup","uEvPos","uEvMax","uFiltreQueue","uEdgeDevigMax","uCalib","uCote","uMise2"].forEach(id => {
  const el=$(id); el.addEventListener("input", renderUpcoming); el.addEventListener("change", renderUpcoming);
});

// --- Liaison des filtres communs entre "DC rétrospectif" et "Paris à
// venir" --------------------------------------------------------------
// Les deux pages partagent plusieurs réglages (catégorie, ligue, marge
// bookmaker, poids du modèle, mouvement de cote, second avis API) : changer
// l'un doit se refléter sur l'autre, pour ne pas avoir à tout re-régler en
// changeant d'onglet. Chaque select déclenche déjà son propre rendu (ci-
// dessus et plus haut) ; ce bloc ajoute SEULEMENT la synchronisation de
// valeur entre les deux, sans dupliquer la logique de filtrage.
function lierFiltres(idA, idB) {
  const elA = $(idA), elB = $(idB);
  if (!elA || !elB) return;
  // La garde (valeurs déjà égales -> ne rien redéclencher) empêche une
  // boucle infinie entre les deux écouteurs.
  elA.addEventListener("change", () => {
    if (elB.value === elA.value) return;
    elB.value = elA.value;
    elB.dispatchEvent(new Event("change"));
  });
  elB.addEventListener("change", () => {
    if (elA.value === elB.value) return;
    elA.value = elB.value;
    elA.dispatchEvent(new Event("change"));
  });
}
// Cases a cocher "Type de pari" : elles ne sont pas des <select>, donc ni
// les ecouteurs ni lierFiltres() ne les prennent en charge. On les cable a
// la main, en gardant les deux pages synchronisees comme les autres filtres.
function cablerCasesCategorie() {
  const paires = [["bt", renderBacktest], ["u", renderUpcoming]];
  paires.forEach(([pref, redessiner]) => {
    document.querySelectorAll("." + pref + "CatChk").forEach(boite => {
      boite.addEventListener("change", () => {
        // Report de la meme selection sur l'autre page.
        const autre = pref === "bt" ? "u" : "bt";
        document.querySelectorAll("." + autre + "CatChk").forEach(jumelle => {
          if (jumelle.value === boite.value) jumelle.checked = boite.checked;
        });
        libelleMsel(pref);
        libelleMsel(autre);
        if (typeof renderBacktest === "function") renderBacktest();
        if (typeof renderUpcoming === "function") renderUpcoming();
      });
    });
  });
}
cablerCasesCategorie();

// --- Type de pari : le groupe de cases est replie dans un menu deroulant --
// (voir le commentaire CSS .msel dans style.css). Le texte du bouton resume
// la selection courante ; le panneau s'ouvre/se ferme au clic et se
// referme au clic ailleurs ou sur Echap, comme un <select> natif.
function libelleMsel(prefixe) {
  const boites = [...document.querySelectorAll("." + prefixe + "CatChk")];
  const texte = $(prefixe + "CatBtnText");
  if (!texte || !boites.length) return;
  const coche = boites.filter(b => b.checked);
  if (!coche.length) texte.textContent = "Aucune (= toutes)";
  else if (coche.length === boites.length) texte.textContent = "Toutes";
  else if (coche.length === 1) texte.textContent = coche[0].value;
  else texte.textContent = coche.length + " sur " + boites.length;
}

// --- Ligue : même widget, mais liste peuplée dynamiquement (voir initMeta)
// et rien de coché par défaut (voir liguesCochees). Câblé séparément de
// cablerCasesCategorie() parce que les cases n'existent pas encore au
// chargement du script — elles sont injectées après coup — et parce que le
// texte du bouton n'a pas le même cas particulier "tout décoché".
function cablerCasesLigue() {
  ["bt", "u"].forEach(pref => {
    document.querySelectorAll("." + pref + "LigueChk").forEach(boite => {
      boite.addEventListener("change", () => {
        const autre = pref === "bt" ? "u" : "bt";
        document.querySelectorAll("." + autre + "LigueChk").forEach(jumelle => {
          if (jumelle.value === boite.value) jumelle.checked = boite.checked;
        });
        libelleMselLigue(pref);
        libelleMselLigue(autre);
        if (typeof renderBacktest === "function") renderBacktest();
        if (typeof renderUpcoming === "function") renderUpcoming();
      });
    });
  });
}
cablerCasesLigue();

function libelleMselLigue(prefixe) {
  const boites = [...document.querySelectorAll("." + prefixe + "LigueChk")];
  const texte = $(prefixe + "LigueBtnText");
  if (!texte) return;
  const coche = boites.filter(b => b.checked);
  if (!coche.length) texte.textContent = "Toutes";
  else if (coche.length === 1) texte.textContent = coche[0].dataset.label || coche[0].value;
  else texte.textContent = coche.length + " ligues";
}

// Recherche texte dans le panneau Ligue : la liste peut dépasser 50 entrées,
// ce qu'un <select> natif géère avec la saisie au clavier mais qu'un menu à
// cases à cocher n'offre pas nativement — on le recrée ici.
function filtrerOptionsLigue(prefixe) {
  const rech = $(prefixe + "LigueSearch");
  const terme = rech ? rech.value.trim().toLowerCase() : "";
  document.querySelectorAll("#" + prefixe + "LigueOptions .chk-cat").forEach(label => {
    const texte = label.textContent.toLowerCase();
    label.style.display = (!terme || texte.includes(terme)) ? "" : "none";
  });
}
["bt", "u"].forEach(pref => {
  const rech = $(pref + "LigueSearch");
  if (rech) rech.addEventListener("input", () => filtrerOptionsLigue(pref));
});

// Tout cocher / Tout décocher (menu Ligue) : n'agit que sur les options
// actuellement VISIBLES (voir filtrerOptionsLigue ci-dessus) — taper
// "France" puis "Tout cocher" sélectionne uniquement les championnats
// français sans toucher au reste de la liste, et "Tout décocher" vide la
// recherche en cours plutôt que la totalité des ~50-60 ligues. Répercute
// la sélection sur l'autre page (comme cablerCasesLigue) et ne redessine
// qu'une seule fois à la fin, plutôt qu'à chaque case comme un clic manuel
// l'aurait fait — sinon cocher 40 ligues d'un coup redessinerait 40 fois.
function cablerActionsLigue(prefixe) {
  const boutonCocher = $(prefixe + "LigueCheckAll");
  const boutonDecocher = $(prefixe + "LigueUncheckAll");
  if (!boutonCocher && !boutonDecocher) return;
  const autre = prefixe === "bt" ? "u" : "bt";
  const appliquer = (valeur) => {
    document.querySelectorAll("#" + prefixe + "LigueOptions .chk-cat").forEach(label => {
      if (label.style.display === "none") return;
      const input = label.querySelector("input." + prefixe + "LigueChk");
      if (!input) return;
      input.checked = valeur;
      document.querySelectorAll("." + autre + "LigueChk").forEach(jumelle => {
        if (jumelle.value === input.value) jumelle.checked = valeur;
      });
    });
    libelleMselLigue(prefixe);
    libelleMselLigue(autre);
    if (typeof renderBacktest === "function") renderBacktest();
    if (typeof renderUpcoming === "function") renderUpcoming();
  };
  if (boutonCocher) boutonCocher.addEventListener("click", () => appliquer(true));
  if (boutonDecocher) boutonDecocher.addEventListener("click", () => appliquer(false));
}
["bt", "u"].forEach(cablerActionsLigue);

// Ouverture/fermeture d'un menu "case a cocher" du gabarit .msel — factorise
// pour servir aussi bien Type de pari que Ligue (et tout futur menu du même
// genre) : un seul menu ouvert a la fois, fermeture au clic ailleurs ou sur
// Echap, comme un <select> natif.
function cablerMenuDeroulant(mselId, boutonId, onOuverture) {
  const msel = $(mselId), bouton = $(boutonId);
  if (!msel || !bouton) return;
  bouton.addEventListener("click", () => {
    const dejaOuvert = msel.classList.contains("open");
    // Un seul menu ouvert a la fois (les deux pages partagent l'ecran
    // sur les breakpoints larges, mieux vaut ne pas en laisser trainer).
    document.querySelectorAll(".msel.open").forEach(autre => {
      autre.classList.remove("open");
      const b = autre.querySelector(".msel-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
    if (!dejaOuvert) {
      msel.classList.add("open");
      bouton.setAttribute("aria-expanded", "true");
      if (onOuverture) onOuverture();
    }
  });
}

function cablerMenusDeroulants() {
  ["bt", "u"].forEach(pref => {
    cablerMenuDeroulant(pref + "Cat", pref + "CatBtn");
    libelleMsel(pref);
    // Ligue : la recherche repart vide et reprend le focus a chaque
    // ouverture, pour retrouver au clavier le confort d'un <select> natif.
    cablerMenuDeroulant(pref + "LigueMsel", pref + "LigueBtn", () => {
      const rech = $(pref + "LigueSearch");
      if (!rech) return;
      rech.value = "";
      filtrerOptionsLigue(pref);
      rech.focus();
    });
    libelleMselLigue(pref);
  });
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".msel.open").forEach(msel => {
      if (!msel.contains(e.target)) {
        msel.classList.remove("open");
        const b = msel.querySelector(".msel-btn");
        if (b) b.setAttribute("aria-expanded", "false");
      }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".msel.open").forEach(msel => {
      msel.classList.remove("open");
      const b = msel.querySelector(".msel-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  });
}
cablerMenusDeroulants();

[["btDevig","uDevig"], ["btAlpha","uAlpha"],
 ["btMvt","uMvt"], ["btPred","uPred"], ["btEnrichi","uEnrichi"], ["btLoi","uLoi"],
 ["btDedup","uDedup"],
 ["btEvPos","uEvPos"], ["btEvMax","uEvMax"], ["btFiltreQueue","uFiltreQueue"], ["btEdgeDevigMax","uEdgeDevigMax"],
 ["btCalib","uCalib"], ["btEdge","uEdge"], ["btMise","uMise2"],
 ["btCoteRange","uCote"]].forEach(([a,b]) => lierFiltres(a,b));

// Sans ratio mesurable (backtest de moins de 100 paris, ou ratio aberrant
// — voir build_dc_backtest côté Python), le filtre n'a rien à appliquer :
// mieux vaut le griser en disant pourquoi que de le laisser cliquable sans
// effet visible, ce qui donnerait l'impression d'un bug.
["btCalib", "uCalib"].forEach(id => {
  const el = $(id);
  if (!el) return;
  if (!CALIB_RATIO) {
    el.value = "0";
    el.disabled = true;
    el.title = "Indisponible : l'historique du backtest est trop court pour "
             + "mesurer un ratio de calibration fiable (100 paris minimum).";
  } else {
    el.title = `Ratio mesuré sur le backtest : ${CALIB_RATIO.toFixed(3)} — le modèle `
             + `surestime ses probabilités d'environ `
             + `${((1 - CALIB_RATIO) * 100).toFixed(1)} %. La correction les ramène `
             + `à leur niveau réellement observé.`;
  }
});

// Même principe que btCalib/uCalib ci-dessus : sans r estimable (backtest
// trop court, ou aucune survariance détectable — voir
// estimer_dispersion_nbinom côté Python), le filtre n'a rien à appliquer.
["btLoi", "uLoi"].forEach(id => {
  const el = $(id);
  if (!el) return;
  if (!NB_R) {
    el.value = "poisson";
    el.disabled = true;
    el.title = "Indisponible : le backtest est trop court, ou aucune survariance "
             + "n'est détectable pour l'instant par rapport à Poisson (voir le panneau "
             + "« Binomiale négative » sur DC rétrospectif).";
  } else {
    const v = NB_VALIDATION || {};
    el.title = `r estimé sur le backtest : ${v.r_estime}. Off par défaut : Poisson reste `
             + `le modèle actif tant que vous n'activez pas ce filtre vous-même.`;
  }
});

// Télécharge directement le fichier paris_joues.json : bien plus pratique
// que le copier-coller manuel (l'artefact ne peut pas écrire sur le disque
// ni utiliser le stockage du navigateur, donc le téléchargement est la
// solution la plus directe pour faire persister les coches).
(function initDownloadPlaced() {
  const btn = $("downloadPlaced");
  if (!btn) return;
  btn.addEventListener("click", () => {
    // Object.fromEntries (pas [...PLACED]) : PLACED est une Map clé->{mise},
    // [...PLACED] donnerait un tableau de paires [clé, valeur] au lieu du
    // dict {"clé": {...}} attendu par load_placed_bets() côté Python —
    // exactement le bug qui produisait des clés du genre
    // "['date|match|pari', {'mise': 6}]" dans le tableau de bord.
    const contenu = JSON.stringify(Object.fromEntries(PLACED), null, 1);
    const blob = new Blob([contenu], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "paris_joues.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const fb = $("copyFeedback");
    if (fb) {
      fb.textContent = "Téléchargé — dépose-le à côté de wina_wizard.py";
      setTimeout(() => { fb.textContent = ""; }, 5000);
    }
  });
})();

// Copie la liste des paris joués dans le presse-papiers
(function initCopyPlaced() {
  const btn = $("copyPlaced");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const ta = $("placedExport"), fb = $("copyFeedback");
    try {
      await navigator.clipboard.writeText(ta.value);
      fb.textContent = "Copié — colle-le dans paris_joues.json";
    } catch {
      // Repli si le presse-papiers est refusé (ouverture en fichier local)
      ta.select();
      fb.textContent = "Sélectionné — fais Ctrl+C pour copier";
    }
    setTimeout(() => { fb.textContent = ""; }, 4000);
  });
})();

/* ================= PAGE 4 — STATS ÉQUIPES ================= */
function teamLigueOptions(pays) {
  const parKey = new Map();
  TEAM_STATS.filter(t => !pays || t.pays === pays).forEach(t => {
    if (t.ligue && !parKey.has(ligueKey(t.pays, t.ligue))) parKey.set(ligueKey(t.pays, t.ligue), t);
  });
  return [...parKey.values()].sort((a, b) => ligueLabel(a.pays, a.ligue).localeCompare(ligueLabel(b.pays, b.ligue)));
}

(function initTeamFilters() {
  const pays = [...new Set(TEAM_STATS.map(t => t.pays).filter(Boolean))].sort();
  const annees = [...new Set(TEAM_STATS.flatMap(t => t.annees || []))].sort();
  const fill = (sel, vals) => vals.forEach(v => { const o=document.createElement("option"); o.value=v; o.textContent=v; $(sel).appendChild(o); });
  fill("tPays", pays);
  // Valeur = clé combinée pays+ligue (voir ligueKey), texte = "Pays - Ligue" :
  // un nom de ligue seul (ex. "Ligue 1") peut désigner plusieurs championnats.
  teamLigueOptions("").forEach(t => {
    const o = document.createElement("option");
    o.value = ligueKey(t.pays, t.ligue); o.textContent = ligueLabel(t.pays, t.ligue);
    $("tLigue").appendChild(o);
  });
  fill("tAnnee", annees);
})();

let tSortKey = "atk_home", tSortDir = -1;

// Quand on choisit un pays, restreindre les ligues à ce pays
$("tPays").addEventListener("change", () => {
  const pays = $("tPays").value;
  const sel = $("tLigue"), cur = sel.value;
  sel.innerHTML = '<option value="">Toutes</option>';
  teamLigueOptions(pays).forEach(t => {
    const o = document.createElement("option");
    o.value = ligueKey(t.pays, t.ligue); o.textContent = ligueLabel(t.pays, t.ligue);
    sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  renderTeams();
});

function teamCell(val, isDefense) {
  if (val == null) return '<td class="num muted">—</td>';
  // Attaque : >1 favorable (vert). Défense : <1 favorable (vert).
  const good = isDefense ? val < 1 : val > 1;
  const cls = good ? "pos" : (val === 1 ? "" : "neg");
  return `<td class="num ${cls}">${val.toFixed(2)}</td>`;
}

function renderTeams() {
  const pays = $("tPays").value, ligue = $("tLigue").value, annee = $("tAnnee").value;
  const search = $("tSearch").value.trim().toLowerCase();
  const minM = parseInt($("tMinMatches").value) || 0;

  let rows = TEAM_STATS.filter(t =>
    (!pays || t.pays === pays) &&
    (!ligue || ligueKey(t.pays, t.ligue) === ligue) &&
    (!annee || (t.annees || []).includes(annee)) &&
    (!search || t.equipe.toLowerCase().includes(search)) &&
    (Math.max(t.n_home||0, t.n_away||0) >= minM)
  );
  rows.sort((a,b) => {
    let va = a[tSortKey], vb = b[tSortKey];
    if (va == null) va = -Infinity; if (vb == null) vb = -Infinity;
    if (typeof va === "string") { return tSortDir * va.localeCompare(vb); }
    return tSortDir * (va - vb);
  });

  $("teamBody").innerHTML = rows.slice(0, 500).map(t => `
    <tr>
      <td><strong>${t.equipe}</strong></td>
      <td><span class="pill">${ligueLabel(t.pays, t.ligue)}</span></td>
      ${teamCell(t.atk_home, false)}
      ${teamCell(t.def_home, true)}
      ${teamCell(t.atk_away, false)}
      ${teamCell(t.def_away, true)}
      <td class="num muted">${t.n_home}</td>
      <td class="num muted">${t.n_away}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">Aucune équipe ne correspond${TEAM_STATS.length? " à ces filtres." : " (historique de résultats encore vide)."}</td></tr>`;
  $("teamRowInfo").textContent = `${rows.length} équipe(s)` + (rows.length>500?" (500 affichées)":"");
  $("teamCount").textContent = `— ${TEAM_STATS.length} équipe(s) au total`;
}
["tPays","tLigue","tAnnee","tSearch","tMinMatches"].forEach(id => {
  const el=$(id); el.addEventListener("input", renderTeams); el.addEventListener("change", renderTeams);
});
document.querySelectorAll("#teamTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.tk;
    if (tSortKey===k) tSortDir*=-1; else { tSortKey=k; tSortDir=(k==="equipe"||k==="ligue")?1:-1; }
    renderTeams();
  });
});

/* ================= PAGE 0 — VUE D'ENSEMBLE ================= */
// Bascule vers un autre onglet en JS — utilisé par le chip d'alerte
// "Qualité des données" ci-dessous pour renvoyer directement au panneau de
// diagnostic concerné (matchs non rapprochés / compétitions non alignées),
// plutôt que de laisser deviner où cliquer.
function irVersOnglet(page) {
  const tab = document.querySelector(`.tab[data-page="${page}"]`);
  if (tab) tab.click();
}
document.addEventListener("click", e => {
  const chip = e.target.closest(".ov-jump-tab");
  if (chip) irVersOnglet(chip.dataset.page);
});

// Cette page servait auparavant les stats du "pari sur tout" (BETS) :
// trompeur, car ce n'est pas une stratégie jouable — juste une mesure du
// coût de la marge bookmaker (utile sur la page Rétrospectif, où c'est
// explicite, pas ici en vitrine). Ce qui compte vraiment, c'est le backtest
// Dixon-Coles sur les VALUE BETS (BT_ROWS, edge déjà positif) : la seule
// chose qui ressemble à ce qu'on jouerait réellement. Voir aussi
// dcCategoryVerdicts()/catBadgeHtml(), déjà utilisés sur "Paris à venir" et
// "DC rétrospectif" — réutilisés ici pour que le verdict par catégorie soit
// visible dès la première page, pas seulement dans les onglets de détail.
function renderOverview() {
  const stake = 10; // mise de référence pour la vue d'ensemble (indépendante des filtres des autres onglets)
  const n = BT_ROWS.length;
  let net = 0, wins = 0;
  BT_ROWS.forEach(r => { net += r.profit * stake; if (r.gagne) wins++; });
  const roi = n > 0 ? net / (n * stake) : null;

  const verdicts = dcCategoryVerdicts();
  const catNoms = Object.keys(verdicts);
  const nRobustes = catNoms.filter(c => verdicts[c].verdict.code === "robuste").length;

  const netEl = $("ovNet");
  netEl.textContent = fmtEur(net);
  netEl.className = "st-value " + (net >= 0 ? "pos" : "neg");
  $("ovNetSub").textContent = `${n} value bet(s) évalué(s)`;
  const bar = $("ovNetBar");
  bar.style.width = Math.min(100, Math.abs(roi || 0) * 150).toFixed(0) + "%";
  bar.style.background = net >= 0 ? "var(--pitch)" : "var(--card-red)";

  const roiEl = $("ovRoi");
  roiEl.textContent = fmtPct(roi);
  roiEl.className = "st-value " + (roi >= 0 ? "pos" : "neg");
  // Un ROI global positif peut cacher un mélange (1 catégorie qui tire tout
  // vers le haut, les autres perdantes) — d'où ce rappel explicite plutôt
  // qu'un simple "sur N paris", avec le détail juste en dessous.
  $("ovRoiSub").textContent = catNoms.length
    ? `${nRobustes} / ${catNoms.length} catégorie(s) robuste(s) — détail ci-dessous`
    : "aucune donnée";

  $("ovWin").textContent = n > 0 ? (wins / n * 100).toFixed(1) + " %" : "—";
  $("ovWinSub").textContent = n > 0 ? `${wins} / ${n} gagnés` : "value bets";

  $("ovUpcoming").textContent = UPCOMING.length;
  $("ovUpcomingSub").textContent = `sur ${UPCOMING_DAYS} jours · modèle Dixon-Coles`;

  // Même mécanique que drawChart (mise fixe, cumul par ordre chronologique),
  // mais sur les value bets réels : profit/gagne/categorie/colonne portent
  // des noms différents côté DC backtest (voir build_dc_backtest), d'où ce
  // petit mappage vers les champs attendus par drawChart.
  const chartRows = BT_ROWS.map(r => ({
    date: r.date, match: r.match, cote: r.cote, won: r.gagne, col: r.colonne,
  }));
  drawChart(chartRows, stake, "ovChartWrap", 300);

  const catRows = catNoms.map(cat => ({ cat, ...verdicts[cat] }))
    .sort((a, b) => (b.roi ?? -99) - (a.roi ?? -99));
  $("ovCatList").innerHTML = catRows.map(c => `
    <li>
      <div><div class="ov-name">${c.cat} ${catBadgeHtml(c.cat)}</div><div class="ov-meta">${c.n} value bet(s)</div></div>
      <div class="ov-val ${c.roi >= 0 ? 'pos' : 'neg'}">${fmtPct(c.roi)}</div>
    </li>`).join("") || `<li class="muted">Pas encore de données.</li>`;

  const topUpcoming = UPCOMING.slice().sort((a, b) => b.ev - a.ev).slice(0, 5);
  $("ovUpcomingList").innerHTML = topUpcoming.map(v => `
    <li>
      <div><div class="ov-name">${v.match} ${catBadgeHtml(v.categorie)}</div><div class="ov-meta">${v.colonne} · cote ${v.cote.toFixed(2)}</div></div>
      <div class="ov-val pos">${fmtPct(v.ev)}</div>
    </li>`).join("") || `<li class="muted">Aucune piste pour l'instant — reviens après la prochaine collecte.</li>`;

  // Qualité des données : chips de contexte (comme avant) + un chip
  // d'alerte cliquable si des matchs/compétitions restent mal alignés
  // (fusion backtest + poisson, même logique qu'initLiguesNonAlignees), ou
  // un chip rassurant sinon — pour qu'un problème d'alignement saute aux
  // yeux dès la première page plutôt que d'être découvert par hasard sur
  // Rétrospectif.
  const m = WIZARD_DATA.meta;
  const totalNonRapproches = m.unmatched || 0;
  const compteLigues = new Map();
  const ajouterLigues = src => (src || []).forEach(([cle, cnt]) => compteLigues.set(cle, (compteLigues.get(cle) || 0) + cnt));
  ajouterLigues((WIZARD_DATA.dc_stats || {}).ligues_non_alignees);
  ajouterLigues((WIZARD_DATA.poisson_stats || {}).ligues_non_alignees);
  const totalLiguesNonAlignees = compteLigues.size;

  const chips = [
    `${m.n_odds_files} fichier(s) cotes`,
    `${m.n_results_files} fichier(s) résultats`,
    `${m.matched} match(s) rapproché(s)`,
    `${TEAM_STATS.length} équipe(s) modélisée(s)`,
    `${VALUE_BETS.length} value bet(s) au total`,
  ];
  let html = chips.map(c => `<span class="coverage-chip">${c}</span>`).join("");
  if (totalNonRapproches > 0 || totalLiguesNonAlignees > 0) {
    const details = [];
    if (totalNonRapproches > 0) details.push(`${totalNonRapproches} match(s) non rapproché(s)`);
    if (totalLiguesNonAlignees > 0) details.push(`${totalLiguesNonAlignees} compétition(s) non alignée(s)`);
    html += `<button type="button" class="coverage-chip alert link ov-jump-tab" data-page="retro">⚠ ${details.join(" · ")} — corriger</button>`;
  } else {
    html += `<span class="coverage-chip ok">✓ Aucun souci d'alignement détecté</span>`;
  }
  $("ovCoverage").innerHTML = html;
}

/* ================= PAGE — DIXON-COLES RÉTROSPECTIF ================= */
const BT_ROWS = WIZARD_DATA.dc_backtest || [];

// Garantie 2 buts : sans chronologie des buts collectée (api_football_
// collect.py, endpoint /fixtures/events), aucun pari ne porte l'indicateur
// — le filtre n'aurait rien à appliquer. On le grise en disant pourquoi
// plutôt que de le laisser sans effet visible.
{
  const el = $("btGarantie");
  if (el) {
    const n = BT_ROWS.filter(r => r.garantie_eligible).length;
    if (!n) {
      el.value = "0";
      el.disabled = true;
      el.title = "Indisponible : la chronologie des buts n'a pas encore été "
               + "collectée. Lancez api_football_collect.py, qui récupère les "
               + "minutes de but des matchs du backtest.";
    } else {
      const sauves = BT_ROWS.filter(r => r.garantie_sauve).length;
      el.title = `${n} pari(s) Résultat en ligue éligible, dont ${sauves} que `
               + `la garantie rend gagnant(s).`;
    }
  }
}

const BT_STATS = WIZARD_DATA.dc_stats || {};

// --- Fiabilité historique par catégorie de pari --------------------------
// Même méthode que le tableau "Par catégorie" plus bas (split train/test,
// mêmes seuils MIN_BETS/OOS_MIN), mais appliquée ici au dataset qui compte
// vraiment pour juger si UN MARCHÉ vaut la peine d'être joué : les VALUE
// BETS du backtest Dixon-Coles (BT_ROWS, edge déjà positif), pas "parier
// sur tout" (ce que fait updateCategoryTable sur la page Rétrospectif —
// utile pour montrer le coût de la marge bookmaker, mais pas pour juger le
// modèle). Calculé une seule fois puis réutilisé partout où une catégorie
// apparaît : filtre de "Paris à venir", badge sur chaque carte de
// recommandation, et colonne de ce même tableau "Par catégorie" ci-dessous.
let _dcCatVerdicts = null;
function dcCategoryVerdicts() {
  if (_dcCatVerdicts) return _dcCatVerdicts;
  const cats = {};
  BT_ROWS.forEach(r => { (cats[r.categorie] = cats[r.categorie] || []).push(r); });
  const out = {};
  Object.keys(cats).forEach(cat => {
    const arr = cats[cat].slice().sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
    const n = arr.length;
    const split = Math.floor(n / 2);
    const roiOf = list => list.length ? list.reduce((s, r) => s + r.profit, 0) / list.length : null;
    const train = arr.slice(0, split), test = arr.slice(split);
    const roi = roiOf(arr), trainRoi = roiOf(train), testRoi = roiOf(test);
    let verdict;
    if (n < MIN_BETS || test.length < OOS_MIN) {
      verdict = { code: "insuffisant", label: "Données insuffisantes", color: "#555" };
    } else if (trainRoi > 0 && testRoi > 0) {
      verdict = { code: "robuste", label: "Robuste", color: "#1a7f5a" };
    } else if (trainRoi > 0 && testRoi <= 0) {
      verdict = { code: "overfit", label: "Disparaît en test", color: "#b23b3b" };
    } else {
      verdict = { code: "non_rentable", label: "Non rentable", color: "#8a6d1f" };
    }
    out[cat] = { n, roi, trainRoi, testRoi, verdict };
  });
  _dcCatVerdicts = out;
  return out;
}

// Badge compact réutilisé partout où une catégorie de pari est affichée à
// côté d'un verdict (carte de recommandation, filtre). Le survol détaille
// le ROI réel et la taille de l'échantillon, pour ne pas se fier au seul
// mot ("Robuste" sur 31 paris et sur 900 n'inspire pas la même confiance,
// même si le badge est identique).
function catBadgeHtml(categorie) {
  const v = dcCategoryVerdicts()[categorie];
  if (!v) return "";
  const titre = v.roi != null
    ? `Backtest Dixon-Coles (value bets) : ${v.n} pari(s), ROI ${fmtPct(v.roi)} `
      + `(entraînement ${fmtPct(v.trainRoi)} / test ${fmtPct(v.testRoi)})`
    : `${v.n} pari(s) testé(s) — pas encore assez pour un verdict`;
  return `<span class="badge cat-verdict" style="background:${v.verdict.color}" title="${titre}">${v.verdict.label}</span>`;
}

// Étiquette le filtre "Type de pari" (Paris à venir ET DC rétrospectif) avec
// le même badge que les cartes, pour qu'on voie d'emblée qu'une catégorie
// est historiquement perdante SANS avoir à décocher/recocher pour vérifier.
// Purement informatif : ne change aucune case cochée par défaut — la
// décision de jouer une catégorie reste à l'utilisateur, pas décidée à sa
// place par le tableau de bord.
(function initCategoryFilterBadges() {
  document.querySelectorAll(".uCatChk, .btCatChk").forEach(input => {
    const badge = catBadgeHtml(input.value);
    const span = input.nextElementSibling;
    if (badge && span) span.insertAdjacentHTML("afterend", badge);
  });
})();

// Bornes du calendrier : toute la période disponible, calculée côté Python
// (BT_STATS.date_min/max) — avec repli sur un balayage de BT_ROWS pour un
// donnees.js plus ancien qui n'aurait pas encore ces deux champs.
(function initBtDateRange() {
  const deb = $("btDateDebut"), fin = $("btDateFin");
  if (!deb || !fin) return;
  let mn = BT_STATS.date_min, mx = BT_STATS.date_max;
  if (!mn || !mx) {
    const dates = BT_ROWS.map(r => r.date).filter(Boolean).sort();
    mn = dates[0]; mx = dates[dates.length - 1];
  }
  if (mn) { deb.min = mn; deb.value = mn; }
  if (mx) { fin.max = mx; fin.value = mx; }
  if (mn) fin.min = mn;
  if (mx) deb.max = mx;
})();
// Mise du backtest : lue depuis le champ, pour pouvoir simuler d'autres
// montants sans relancer le calcul (les profits sont stockés en UNITÉS de
// mise, donc un simple facteur suffit).
// Filtre unique appliqué partout sur la page DC rétrospectif, pour que les
// KPI, le tableau et le graphique portent toujours sur le MÊME ensemble.
function btFiltered() {
  const f = $("btFilter") ? $("btFilter").value : "";
  const cats = categoriesCochees("bt");
  const ligues = liguesCochees("bt");
  const dedup = $("btDedup") ? $("btDedup").value === "1" : false;
  const devig = $("btDevig") ? $("btDevig").value === "1" : false;
  const modeXg = $("btEnrichi") ? $("btEnrichi").value : "sans";
  // Intervalle de dates choisi au calendrier — remplace l'ancienne fenêtre
  // fixe de 14 jours. r.date est au format AAAA-MM-JJ, exactement celui que
  // renvoie un <input type="date">, donc une comparaison de chaînes suffit
  // sans repasser par des objets Date.
  const dateDebut = $("btDateDebut") ? $("btDateDebut").value : "";
  const dateFin = $("btDateFin") ? $("btDateFin").value : "";

  // ENRICHISSEMENT xG. Plutôt que de faire vérifier le mode par chaque
  // fonction consommatrice (blended, btAgg, drawCalibration...), la
  // substitution se fait UNE SEULE FOIS ici : les champs p_model/edge/
  // edge_devig/ev/lam_home/lam_away de la copie renvoyée portent déjà la
  // bonne valeur pour le mode actif. Tout le reste de la page continue de
  // lire ces noms de champs sans rien savoir du mode — c'est ce qui
  // garantit qu'aucun graphique ni KPI n'a pu être oublié dans le
  // branchement.
  //
  // Les matchs sans historique xG suffisant sont EXCLUS en mode « avec »,
  // jamais comblés par la valeur en buts déguisée en xG : mélanger les
  // deux logiques dans une même moyenne aurait rendu la comparaison
  // trompeuse plutôt qu'absente.
  // La correction de calibration s'applique AVANT la substitution xG, sur
  // l'ensemble brut : les deux jeux de probabilités (buts et xG) sont
  // corrigés du même facteur, puis la substitution choisit lequel utiliser.
  // Dans l'ordre inverse, seule la lecture active aurait été corrigée et
  // l'infobulle aurait affiché deux valeurs incohérentes entre elles.
  const calibActif = $("btCalib") ? $("btCalib").value === "1" : false;
  // Binomiale négative : exclusive avec l'xG (voir appliquerNb) — sans
  // effet tant que l'enrichissement xG est actif, quelle que soit la valeur
  // du sélecteur.
  const nbActif = $("btLoi") && $("btLoi").value === "nbinom" && modeXg === "sans";
  let source = appliquerXg(appliquerNb(calibrer(BT_ROWS, calibActif), nbActif), modeXg);

  // Les paris sont stockés avec leurs DEUX edges (brut et marge retirée).
  // Selon le mode, on ne garde que ceux qui passaient le seuil dans cette
  // lecture-là — sinon on comparerait des ensembles différents.
  // Pilotable depuis la page (auparavant figé à MIN_EDGE, alors que la page
  // « Paris à venir » proposait déjà ce réglage : les deux vues ne
  // montraient donc pas le même ensemble à réglages identiques).
  const seuil = $("btEdge") ? (parseFloat($("btEdge").value) || MIN_EDGE) : MIN_EDGE;
  const plageCote = $("btCoteRange") ? $("btCoteRange").value : "";
  // Garantie 2 Buts d'Écart (Winamax) : sur un pari Résultat d'une ligue
  // éligible, si l'équipe a mené de 2 buts à un moment du match, le pari
  // est payé gagnant même si elle finit par ne pas gagner.
  //   "1" = appliquer  -> les paris sauvés comptent comme gagnants
  //   "2" = isoler     -> ne montrer QUE les paris que la garantie sauve,
  //                       pour voir concrètement ce qu'elle apporte
  // Le profit corrigé (profit_garantie) est calculé côté Python ; ici on
  // ne fait que choisir quelle lecture utiliser.
  const garantie = $("btGarantie") ? $("btGarantie").value : "0";
  const alpha = blendAlpha("btAlpha");
  // Filtre sur le MOUVEMENT DE LA COTE entre la première et la dernière
  // capture. Une cote qui raccourcit signale que de l'argent est entré sur
  // cette issue — souvent de l'argent informé. Ce filtre permet de simuler
  // « et si je n'avais suivi que le marché ? » sans rien recalculer.
  const mvt = $("btMvt") ? $("btMvt").value : "";
  // Second avis (API) : ne concerne que les matchs dont la prévision avait
  // été collectée quand ils étaient encore à venir (cf. apply_predictions
  // côté Python) — la plupart des lignes n'en ont pas encore, ce qui est
  // normal tant que la collecte prospective n'a pas eu le temps de couvrir
  // suffisamment de matchs désormais joués.
  const pred = $("btPred") ? $("btPred").value : "";
  // Espérance : un edge dévigué positif ne garantit PAS une espérance
  // positive. Sur une cote très basse, la marge du bookmaker peut dépasser
  // l'avantage du modèle — ex. cote 1.03 avec 91 % de probabilité : edge
  // dévigué +2,5 % mais espérance -6,3 %, car il faudrait gagner 97,1 % du
  // temps pour rentrer dans ses frais. L'espérance est la seule mesure de
  // ce qu'un pari rapporte vraiment.
  // -999 = pas de filtre ; 0 = strictement positive ; 0.02 = au moins +2 %.
  const seuilEv = $("btEvPos") ? parseFloat($("btEvPos").value) : -999;
  // Plafond d'espérance : 999 = pas de plafond. Mesure empirique du
  // 20/09/2026 (export réel, catégories Plus/Moins de buts + Intervalle de
  // buts) — les paris affichant plus de +50 % d'espérance étaient à 0 %
  // de réussite (0 sur 14), contre un taux normal ailleurs dans le même
  // échantillon : une espérance aussi extrême signale presque toujours une
  // erreur du modèle (queue de distribution des buts totaux surestimée),
  // pas une vraie opportunité — voir aussi le bandeau d'avertissement de
  // la page "Paris à venir", qui dit la même chose en mots.
  const seuilEvMax = $("btEvMax") ? parseFloat($("btEvMax").value) : 999;
  // Filtre "marchés de queue" — voir le commentaire sur MARCHES_QUEUE en
  // tête de fichier. Ne s'applique qu'aux deux catégories concernées.
  const filtreQueue = $("btFiltreQueue") ? $("btFiltreQueue").value === "1" : false;
  // Plafond d'edge dévigué, réservé aux deux mêmes catégories : mesure
  // empirique du 20/09/2026 — l'écart entre proba modèle et réussite réelle
  // CROÎT avec l'edge affiché (edge 2-5 % -> ~4 pt d'écart de calibration,
  // 15-25 % -> ~15 pt). Plus notre modèle s'écarte du marché sur CES
  // marchés-là, plus l'écart tient au bruit de notre propre estimation qu'à
  // un vrai désaccord informé — un "winner's curse" classique : sélectionner
  // les plus gros désaccords avec un marché globalement efficient revient à
  // sélectionner le bruit qui va dans notre sens. 999 = pas de plafond.
  const seuilEdgeDevigMax = $("btEdgeDevigMax") ? parseFloat($("btEdgeDevigMax").value) : 999;
  // Substitution AVANT tout filtrage : un pari sauvé par la garantie doit
  // être vu comme gagnant par TOUS les filtres qui suivent (y compris
  // "Afficher : gagnés/perdus") et par les statistiques, pas seulement
  // dans le total de profit. Les champs d'origine sont conservés à part
  // pour pouvoir afficher les deux lectures.
  if (garantie === "1" || garantie === "2") {
    source = source.map(r => r.garantie_sauve
      ? {...r, gagne: true, profit: r.profit_garantie,
         gagne_sans_garantie: r.gagne, profit_sans_garantie: r.profit}
      : r);
  }

  let rows = source.filter(r => {
    // α < 1 : l'edge est celui du mélange avec le marché, forcément plus
    // sévère puisqu'il vaut α fois l'edge dévigé.
    const e = alpha < 1 ? blended(r, alpha).edge
                        : (devig ? (r.edge_devig ?? r.edge) : r.edge);
    if (e < seuil) return false;
    if (!dansPlageCote(r.cote, plageCote)) return false;
    // "Seulement les paris sauvés" : ne garde que ceux que la garantie
    // transforme en gagnants — utile pour voir exactement ce qu'elle
    // change, mais ce n'est PAS une stratégie jouable (on ne sait pas à
    // l'avance quels paris elle sauvera).
    if (garantie === "2" && !r.garantie_sauve) return false;
    // Comparée au mode actif : avec α < 1 l'espérance est celle du mélange,
    // pas celle du modèle seul — sinon le filtre contredirait les chiffres
    // affichés dans les colonnes.
    if (seuilEv > -900 || seuilEvMax < 900) {
      const ev = alpha < 1 ? blended(r, alpha).ev : r.ev;
      if (seuilEv > -900) {
        if (ev == null) return false;
        if (seuilEv === 0 ? ev <= 0 : ev < seuilEv) return false;
      }
      // Une espérance manquante n'est jamais "trop haute" : le plafond ne
      // l'exclut pas, contrairement au plancher ci-dessus.
      if (seuilEvMax < 900 && ev != null && ev > seuilEvMax) return false;
    }
    // Marchés de queue / plafond d'edge dévigué : réservé aux deux
    // catégories identifiées (voir MARCHES_QUEUE, CATEGORIES_FILTRE_QUEUE).
    if (CATEGORIES_FILTRE_QUEUE.has(r.categorie)) {
      if (filtreQueue && MARCHES_QUEUE.has(r.colonne)) return false;
      if (seuilEdgeDevigMax < 900 && e != null && e > seuilEdgeDevigMax) return false;
    }
    if (dateDebut && r.date < dateDebut) return false;
    if (dateFin && r.date > dateFin) return false;
    if (cats && !cats.includes(r.categorie)) return false;
    if (ligues && !ligues.has(ligueKey(r.pays, r.ligue))) return false;
    if (f === "won" && !r.gagne) return false;
    if (f === "lost" && r.gagne) return false;
    if (pred === "accord" && r.prediction_accord !== "accord") return false;
    if (pred === "desaccord" && r.prediction_accord !== "desaccord") return false;
    if (pred === "neutre" && !(r.prediction && !r.prediction_accord)) return false;

    if (mvt) {
      // Un pari sans mouvement mesuré (une seule capture) est écarté dès
      // qu'un filtre de mouvement est actif : on ne peut rien en dire.
      if (r.raccourcit === undefined) return false;
      // variation_proba = proba finale − proba initiale. Une cote qui baisse
      // fait monter la probabilité implicite : la valeur est donc POSITIVE
      // quand la cote raccourcit. (J'avais inversé ce signe.)
      const v = r.variation_proba || 0;      // > 0 = la cote a raccourci
      if (mvt === "racc" && !r.raccourcit) return false;
      if (mvt === "racc_fort" && v < 0.02) return false;
      // « allonge » visait à isoler les cotes qui s'allongent, mais testait
      // r.raccourcit (un simple booléen) au lieu de la variation elle-même :
      // ça gardait aussi les cotes STABLES (ni raccourcies ni vraiment
      // allongées), qui n'ont rien à voir avec un allongement. Corrigé pour
      // ne garder que les variations réellement négatives, symétrique de
      // « racc »/« racc_fort » côté raccourcissement.
      if (mvt === "allonge" && v > -0.0001) return false;
      // Pendant du "fortement raccourci" côté allongement : même seuil (au
      // moins 2 points de probabilité implicite perdus) pour isoler les
      // mouvements de marché les plus marqués dans ce sens.
      if (mvt === "allonge_fort" && v > -0.02) return false;
      if (mvt === "stable" && Math.abs(v) >= 0.01) return false;
      // ÉVITER LES ALLONGEMENTS : le signal le plus solide mesuré sur les
      // données réelles. Les cotes qui s'allongent affichent un ROI très
      // dégradé (le marché s'éloigne de ce que croit le modèle), alors que
      // celles qui raccourcissent ou restent figées s'en sortent bien mieux.
      // Ce filtre est bien plus utile que « suivre les raccourcissements » :
      // il porte sur beaucoup plus de paris.
      if (mvt === "sauf_allonge" && v < -0.0001) return false;
      // Version moins agressive : n'écarte que les FORTS allongements (même
      // seuil que « allonge_fort »), en gardant les allongements légers, les
      // cotes stables et celles qui raccourcissent.
      if (mvt === "sauf_allonge_fort" && v <= -0.02) return false;
    }
    return true;
  });

  if (dedup) {
    // Plusieurs seuils joués sur le même match ne sont PAS des paris
    // indépendants : ils gagnent ou perdent ensemble. Les compter tous gonfle
    // le nombre de paris tout en concentrant le risque, ce qui rend le ROI
    // trompeur. On ne garde donc que le pari à meilleure espérance par
    // (match, catégorie) — exactement la règle appliquée aux recommandations.
    const meilleur = {};
    rows.forEach(r => {
      const k = `${r.match}|${r.date}|${r.categorie}`;
      if (!meilleur[k] || r.ev > meilleur[k].ev) meilleur[k] = r;
    });
    rows = Object.values(meilleur);
  }
  return rows;
}

// Recalcule les agrégats sur un sous-ensemble (le JSON ne contient que les
// totaux bruts, or la déduplication change tout : n, ROI, réussite...).
function btAgg(rows) {
  const n = rows.length;
  if (!n) return {n: 0, roi: null, taux: null, profit: 0, cote_moy: null,
                  wins: 0, wins_attendus: 0, proba_pire_ou_egal: null};
  const profit = rows.reduce((s, r) => s + r.profit, 0);
  const wins = rows.filter(r => r.gagne).length;
  const attendus = rows.reduce((s, r) => s + r.p_model, 0);
  const pMoy = attendus / n;

  // Probabilité d'un résultat aussi mauvais ou pire si le modèle disait vrai
  let probaPire = 0;
  const logFact = k => { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; };
  for (let k = 0; k <= wins; k++) {
    const logC = logFact(n) - logFact(k) - logFact(n - k);
    probaPire += Math.exp(logC + k * Math.log(Math.max(pMoy, 1e-12))
                          + (n - k) * Math.log(Math.max(1 - pMoy, 1e-12)));
  }
  return {
    n, profit, wins,
    roi: profit / n,
    taux: wins / n,
    cote_moy: rows.reduce((s, r) => s + r.cote, 0) / n,
    wins_attendus: Math.round(attendus * 100) / 100,
    proba_pire_ou_egal: Math.min(1, probaPire),
  };
}

function btStake() {
  const el = $("btStake");
  const v = el ? parseFloat(el.value) : 10;
  return isNaN(v) ? 0 : v;
}

// Mise reellement engagee sur UN pari du backtest, selon la strategie
// choisie. En mode "Montant fixe" c'est btStake() pour tous ; en mode Kelly
// elle varie avec l'edge et la cote du pari.
//
// La bankroll de reference est celle de la page Bankroll. Elle reste FIXE
// pendant tout le backtest, au lieu d'etre reevaluee apres chaque pari :
// le vrai Kelly composerait les gains, mais le resultat dependrait alors de
// l'ORDRE des paris, ce qui rendrait la comparaison avec la mise fixe
// trompeuse. On mesure ici l'effet du dimensionnement seul.
function btStakeFor(r) {
  const el = $("btMise");
  const strategie = el ? el.value : "fixe";
  if (strategie === "fixe") return btStake();
  const frac = parseFloat(strategie);
  if (!isFinite(frac)) return btStake();
  const bankroll = parseFloat(($("bkDepart") || {}).value) || 100;
  const p = r.p_aff ?? r.p_model;
  return kellyFraction(p, r.cote, frac) * bankroll;
}

function renderBacktest() {
  // Les agrégats sont recalculés sur l'ensemble filtré : la déduplication
  // change n, ROI, réussite... on ne peut donc pas réutiliser les totaux
  // bruts calculés côté Python.
  const rowsFiltrees = btFiltered();
  const g = rowsFiltrees.length ? btAgg(rowsFiltrees) : (BT_ROWS.length ? btAgg([]) : (BT_STATS.global || {}));
  const empty = $("btEmpty");

  // Étiquette d'intervalle : reflète le calendrier choisi, pas une fenêtre
  // fixe. "Toute la période" si les deux bornes sont vides (aucun filtre
  // de date actif) plutôt que d'afficher des dates qui n'excluent rien.
  const rangeLbl = $("btRangeLabel");
  if (rangeLbl) {
    const deb = $("btDateDebut") ? $("btDateDebut").value : "";
    const fin = $("btDateFin") ? $("btDateFin").value : "";
    const fmt = iso => { const [a,m,j] = iso.split("-"); return `${j}/${m}/${a}`; };
    rangeLbl.textContent = (deb && fin) ? `du ${fmt(deb)} au ${fmt(fin)}`
                          : (deb ? `depuis le ${fmt(deb)}` : (fin ? `jusqu'au ${fmt(fin)}` : "toute la période"));
  }
  const lbl = $("btStakeLabel");
  if (lbl) lbl.textContent = btStake().toLocaleString("fr-FR");

  // Note de transparence sur l'échantillon en mode enrichi : l'xG n'étant
  // disponible que pour les matchs avec un historique suffisant des deux
  // côtés, le nombre de paris comparables est presque toujours plus petit
  // qu'en mode « sans ». Le dire explicitement évite de laisser croire à
  // une baisse de performance qui ne serait qu'une baisse d'échantillon.
  const enrichiNote = $("btEnrichiNote");
  if (enrichiNote) {
    const mode = $("btEnrichi") ? $("btEnrichi").value : "sans";
    if (mode === "sans") {
      enrichiNote.style.display = "none";
    } else {
      const avecXg = BT_ROWS.filter(r => r.p_model_xg != null).length;
      enrichiNote.style.display = "";
      enrichiNote.innerHTML = mode === "auto"
        ? `<strong>Mode « xG si disponible »</strong> — ${g.n || 0} pari(s) retenu(s). `
          + `${avecXg} des ${BT_ROWS.length} paris testés utilisent l'xG ; les autres `
          + `gardent le modèle en buts, aucun n'est écarté.`
        : `<strong>Mode « uniquement les matchs à xG »</strong> — ${g.n || 0} pari(s) `
          + `retenu(s), parmi ${avecXg} paris à xG sur ${BT_ROWS.length} testés. Les `
          + `${BT_ROWS.length - avecXg} autres sont écartés faute d'historique xG suffisant.`;
    }
  }

  majLoiNote("bt");

  // Le mélange avec le marché (alpha < 1) utilise TOUJOURS la probabilité
  // marché dévigée en interne (cf. blended()/pMarche()) — mélanger avec la
  // marge brute, non retirée, biaiserait le calcul en sous-estimant l'edge
  // du modèle. Conséquence : le filtre « Marge bookmaker » n'a d'effet que
  // lorsque le poids du modèle est à 100 %. Le dire explicitement plutôt
  // que de laisser deviner pourquoi rien ne change en le basculant.
  const devigNote = $("btDevigNote");
  if (devigNote) {
    const alphaActif = blendAlpha("btAlpha");
    if (alphaActif < 1) {
      devigNote.style.display = "";
      devigNote.innerHTML = `<strong>Marge bookmaker sans effet ici</strong> — le mélange avec le `
        + `marché (Poids du modèle &lt; 100 %) utilise toujours la marge retirée en interne. `
        + `Repassez « Poids du modèle » à 100 % pour comparer les deux lectures.`;
    } else {
      devigNote.style.display = "none";
    }
  }

  if (!g.n) {
    // Pas encore de quoi tester : on le dit clairement plutôt que d'afficher des zéros.
    ["btNet","btRoi","btWin","btCote","btNb"].forEach(id => { $(id).textContent = "—"; });
    $("btNetSub").textContent = "aucun pari testé";
    $("btWinSub").textContent = "—";
    $("btMatches").textContent = "—";
    $("btNbSub").textContent = "—";
    $("btCatBody").innerHTML = '<tr><td colspan="7" class="muted">Pas encore de données.</td></tr>';
    $("btBody").innerHTML = '<tr><td colspan="9" class="muted">Pas encore de données.</td></tr>';
    empty.style.display = "block";
    empty.textContent = "Aucun match récent ne dispose à la fois de cotes capturées, d'un résultat connu et d'un historique suffisant. Ce test se remplira au fil de la collecte quotidienne.";
    // Vide aussi les graphiques : mieux vaut un message clair qu'un reste
    // d'affichage qui laisserait croire à des données disponibles.
    ["btCalibWrap", "btCoteWrap", "btEvoWrap"].forEach(id => {
      const w = $(id);
      if (w) w.innerHTML = '<p class="muted">En attente de données.</p>';
    });
    const cv = $("btCalibVerdict");
    if (cv) cv.style.display = "none";
    const sp = $("btShotsPanel");
    if (sp) sp.style.display = "none";
    return;
  }
  empty.style.display = "none";

  // Avec des mises variables (Kelly), on ne peut plus multiplier le profit
  // global par une mise unique : chaque pari a la sienne. Net et total mise
  // sont donc recalcules pari par pari, et le ROI devient le rapport des
  // deux — c'est-a-dire le rendement du CAPITAL engage, la seule lecture
  // comparable entre mise fixe et Kelly.
  const strategieBt = $("btMise") ? $("btMise").value : "fixe";
  let net = 0, totalMise = 0;
  rowsFiltrees.forEach(r => {
    const m = btStakeFor(r);
    totalMise += m;
    net += r.profit * m;
  });
  const roiEff = totalMise > 0 ? net / totalMise : 0;

  const netEl = $("btNet");
  netEl.textContent = fmtEur(net);
  netEl.className = "st-value " + (net >= 0 ? "pos" : "neg");
  $("btNetSub").textContent = `${g.n} pari(s) · ${totalMise.toLocaleString("fr-FR",
      {maximumFractionDigits: 0})} € misés`
    + (strategieBt === "fixe" ? "" : ` · mise moyenne ${(totalMise / Math.max(g.n,1)).toFixed(2)} €`);

  const roiEl = $("btRoi");
  roiEl.textContent = fmtPct(roiEff);
  roiEl.className = "st-value " + (roiEff >= 0 ? "pos" : "neg");

  // Avec Kelly, le capital engage est bien plus faible qu'avec une mise
  // fixe : le RESULTAT NET baisse donc mecaniquement, sans que la strategie
  // soit moins bonne. Seul le ROI (rendement du capital reellement engage)
  // permet de comparer les deux. On le dit explicitement, sinon la chute du
  // net donne l'impression trompeuse que Kelly est moins performant.
  const noteMise = $("btMiseNote");
  if (noteMise) {
    if (strategieBt === "fixe") {
      noteMise.style.display = "none";
    } else {
      const fixe = btStake();
      const moyenne = totalMise / Math.max(g.n, 1);
      noteMise.style.display = "";
      noteMise.innerHTML = `<strong>Comparaison avec la mise fixe</strong> — Kelly engage `
        + `${moyenne.toFixed(2)} € par pari en moyenne, contre ${fixe.toFixed(2)} € `
        + `a plat : le <em>resultat net</em> est donc forcement plus faible, puisqu'il `
        + `y a moins d'argent en jeu. C'est le <strong>ROI</strong> ci-dessus qui compare `
        + `les deux a capital egal. Pour miser des montants comparables, augmentez la `
        + `bankroll de depart sur la page Bankroll.`;
    }
  }

  $("btWin").textContent = (g.taux * 100).toFixed(1) + " %";
  $("btWinSub").textContent = `${g.wins} / ${g.n} gagnés` +
    (g.wins_attendus != null ? ` · ${g.wins_attendus} attendu(s)` : "");

  // --- Bandeau d'interprétation : sans repère, un "0 sur 9" paraît
  // catastrophique alors qu'il est souvent banal sur des cotes élevées. ---
  const vb = $("btVerdict");
  if (vb && g.wins_attendus != null) {
    const attendu = g.wins_attendus;
    const proba = g.proba_pire_ou_egal;   // proba d'un résultat aussi mauvais ou pire
    let ton = "neutre", titre = "", texte = "";

    if (g.n < 30) {
      ton = "neutre";
      titre = "Trop peu de paris pour conclure quoi que ce soit.";
      texte = `Avec ${g.n} pari(s), le hasard domine complètement. Le modèle visait ` +
        `<strong>${attendu} réussite(s)</strong> et en a obtenu <strong>${g.wins}</strong>` +
        (proba != null && proba > 0.10
          ? ` — un écart de ce genre survient dans environ ${(proba*100).toFixed(0)} % des cas par pur hasard, même si le modèle est juste.`
          : ".") +
        ` Il faut plusieurs centaines de paris avant que ce chiffre veuille dire quelque chose.`;
    } else if (proba != null && proba < 0.05) {
      ton = "mauvais";
      titre = "Le modèle a nettement sous-performé.";
      texte = `Il visait ${attendu} réussite(s), il en a fait ${g.wins}. Un résultat aussi ` +
        `faible n'arriverait que dans ${(proba*100).toFixed(1)} % des cas si le modèle était juste : ` +
        `ses probabilités sont probablement trop optimistes.`;
    } else if (g.roi > 0) {
      ton = "bon";
      titre = "Résultat positif sur cette période.";
      texte = `${g.wins} réussite(s) pour ${attendu} attendue(s), ROI ${fmtPct(g.roi)}. ` +
        `Encourageant, mais un seul échantillon ne suffit pas : c'est la répétition sur plusieurs ` +
        `semaines qui compte.`;
    } else {
      ton = "neutre";
      titre = "Résultat dans la plage du hasard.";
      texte = `${g.wins} réussite(s) pour ${attendu} attendue(s). L'écart reste explicable par ` +
        `la variance normale — ni validation, ni invalidation du modèle.`;
    }
    vb.className = "verdict-box " + ton;
    vb.innerHTML = `<strong>${titre}</strong> ${texte}`;
    vb.style.display = "";
  }
  $("btCote").textContent = g.cote_moy != null ? g.cote_moy.toFixed(2) : "—";
  $("btMatches").textContent = `sur ${new Set(rowsFiltrees.map(r => r.match + r.date)).size} match(s)`;
  $("btNb").textContent = g.n;
  $("btNbSub").textContent = g.n !== BT_ROWS.length ? `sur ${BT_ROWS.length} au total` : "tous comptés";

  // Tableau par catégorie, recalculé sur l'ensemble filtré
  const cats = {};
  rowsFiltrees.forEach(r => { (cats[r.categorie] = cats[r.categorie] || []).push(r); });
  const catsAgg = {};
  Object.keys(cats).forEach(k => { catsAgg[k] = btAgg(cats[k]); });
  const order = Object.keys(catsAgg).sort((a,b) => (catsAgg[b].roi ?? -99) - (catsAgg[a].roi ?? -99));
  $("btCatBody").innerHTML = order.map(c => {
    const s = catsAgg[c];
    // Net recalculé pari par pari, pas depuis l'agrégat : en mise Kelly,
    // btStakeFor() a besoin des champs du pari (cote, p_aff/p_model) —
    // passer l'objet agrégé s (qui ne les a pas) donnait silencieusement
    // une mise nulle, donc un Net à 0 € pour toutes les catégories dès
    // que la stratégie Kelly était choisie.
    const cnet = cats[c].reduce((sum, r) => sum + r.profit * btStakeFor(r), 0);
    return `<tr>
      <td data-label=""><strong>${c}</strong></td>
      <td data-label="Paris" class="num">${s.n}</td>
      <td data-label="Réussite" class="num">${(s.taux*100).toFixed(1)} %</td>
      <td data-label="Cote moy." class="num">${s.cote_moy != null ? s.cote_moy.toFixed(2) : "—"}</td>
      <td data-label="ROI" class="num ${s.roi>=0?'pos':'neg'}"><strong>${fmtPct(s.roi)}</strong></td>
      <td data-label="Net" class="num ${cnet>=0?'pos':'neg'}">${fmtEur(cnet)}</td>
      <td data-label="Verdict">${catBadgeHtml(c)}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="7" class="muted">Aucune catégorie.</td></tr>';

  renderLigueComparaison(rowsFiltrees);
  renderBacktestRows();
  renderOosValidation();
  renderNbValidation();
  renderMouvement();
  drawCalibration();
  drawParCote();
  drawShotsAnalysis();
  drawEvolution();
}

// Sous ce seuil de paris, le ROI d'une ligue est trop bruité pour se
// distinguer du hasard (cf. le bandeau d'interprétation de btVerdict, même
// logique) : on l'affiche quand même — le masquer donnerait l'impression
// trompeuse qu'il n'y a rien à voir — mais avec un badge "peu de données"
// plutôt qu'en le laissant se confondre avec des lignes solides.
const LIGUE_COMP_SEUIL_FIABLE = 10;

// Tableau "Comparaison des ligues", juste sous le graphique d'évolution du
// gain cumulé : recalculé sur le MÊME ensemble filtré que tout le reste de
// la page (rowsFiltrees, déjà passé par btFiltered()), pas un instantané
// figé — changer un filtre en haut de page le met donc à jour comme le
// reste.
function renderLigueComparaison(rowsFiltrees) {
  const body = $("btLigueCompBody");
  const empty = $("btLigueCompEmpty");
  const table = $("btLigueCompTable");
  if (!body) return;

  const parLigue = {};
  rowsFiltrees.forEach(r => {
    if (!r.ligue) return;
    const k = ligueKey(r.pays, r.ligue);
    (parLigue[k] = parLigue[k] || {label: ligueLabel(r.pays, r.ligue), rows: []}).rows.push(r);
  });
  const cles = Object.keys(parLigue);

  if (!cles.length) {
    body.innerHTML = "";
    if (table) table.style.display = "none";
    if (empty) empty.style.display = "";
    return;
  }
  if (table) table.style.display = "";
  if (empty) empty.style.display = "none";

  const agg = {};
  cles.forEach(k => { agg[k] = btAgg(parLigue[k].rows); });
  const order = cles.sort((a,b) => (agg[b].roi ?? -99) - (agg[a].roi ?? -99));

  body.innerHTML = order.map(k => {
    const s = agg[k];
    const rows = parLigue[k].rows;
    // Même correctif que le tableau par catégorie : net recalculé pari par
    // pari, pour rester juste en mise Kelly (btStakeFor a besoin de cote et
    // p_aff/p_model, absents d'un objet agrégé).
    const net = rows.reduce((sum, r) => sum + r.profit * btStakeFor(r), 0);
    const peuFiable = s.n < LIGUE_COMP_SEUIL_FIABLE;
    return `<tr>
      <td data-label=""><strong>${parLigue[k].label}</strong>${peuFiable
        ? ' <span class="tag-cat" title="Moins de ' + LIGUE_COMP_SEUIL_FIABLE + ' paris : le ROI peut varier fortement d’un pari à l’autre.">peu de données</span>' : ""}</td>
      <td data-label="Paris" class="num">${s.n}</td>
      <td data-label="Réussite" class="num">${(s.taux*100).toFixed(1)} %</td>
      <td data-label="Cote moy." class="num">${s.cote_moy != null ? s.cote_moy.toFixed(2) : "—"}</td>
      <td data-label="ROI" class="num ${s.roi>=0?'pos':'neg'}"><strong>${fmtPct(s.roi)}</strong></td>
      <td data-label="Net" class="num ${net>=0?'pos':'neg'}">${fmtEur(net)}</td>
    </tr>`;
  }).join("");
}

// Colonne et sens de tri du tableau de détail. Par défaut : les plus
// récents en premier, ce qui est l'ordre le plus naturel à la lecture.
let btSortKey = "date", btSortDir = -1;

function renderBacktestRows() {
  const devigActif = $("btDevig") && $("btDevig").value === "1";
  const rows = btFiltered().slice().sort((a, b) => {
    let va, vb;
    if (btSortKey === "edge") {
      // L'edge trié est celui du mode affiché, sinon le tri contredirait
      // visuellement la colonne.
      va = devigActif ? (a.edge_devig ?? a.edge) : a.edge;
      vb = devigActif ? (b.edge_devig ?? b.edge) : b.edge;
    } else if (btSortKey === "gain") {
      va = a.profit; vb = b.profit;
    } else if (btSortKey === "gagne") {
      va = a.gagne ? 1 : 0; vb = b.gagne ? 1 : 0;
    } else {
      va = a[btSortKey]; vb = b[btSortKey];
    }
    if (typeof va === "string") return btSortDir * String(va).localeCompare(String(vb));
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    return btSortDir * (va - vb);
  });

  $("btBody").innerHTML = rows.slice(0, 400).map(r => {
    const gain = r.profit * btStakeFor(r);
    return `<tr>
      <td data-label="Date">${r.date}</td>
      <td data-label="Match"><span class="dc-match" data-dc="${encodeURIComponent(JSON.stringify({
        m: r.match, lh: r.lam_home, la: r.lam_away,
        ad: r.force_att_dom, dd: r.force_def_dom,
        ae: r.force_att_ext, de: r.force_def_ext,
        nd: r.n_hist_dom, ne: r.n_hist_ext, sc: r.score_reel,
        // Tirs cadrés, quand api_football_collect.py les a ramenés pour ce
        // match. Absents (undefined) tant que l'historique se constitue :
        // l'infobulle s'adapte silencieusement à leur présence ou non.
        tcd: r.tirs_cadres_dom, tce: r.tirs_cadres_ext,
        bst: r.buts_selon_tirs, ecf: r.ecart_finition,
        // xG : les DEUX lectures, indépendamment du mode actif de la page.
        // L'infobulle sert à comparer — elle ne doit pas se limiter à ce
        // que montre le mode en cours (r.lam_home a pu être substitué par
        // btFiltered() si le mode « avec » est actif).
        lhb: r.lam_home_buts ?? r.lam_home, lab: r.lam_away_buts ?? r.lam_away,
        lhx: r.lam_home_xg, lax: r.lam_away_xg
      }))}">${r.match}</span></td>
      <td data-label="Score réel"><span class="pill">${r.score_reel}</span></td>
      <td data-label="Pari">${r.colonne}</td>
      <td data-label="Cote" class="num">${r.cote.toFixed(2)}</td>
      <td data-label="Proba modèle" class="num">${(r.p_model*100).toFixed(1)} %</td>
      ${(() => {
        // Un pari est retenu s'il passe le seuil en brut OU en dévigué.
        // Afficher seulement l'edge brut donnait des lignes déroutantes :
        // un edge négatif alors que le pari avait été sélectionné sur son
        // edge dévigué (retirer la marge du bookmaker augmente l'edge).
        // On affiche donc celui du mode actif, en signalant l'autre quand
        // il diverge en signe.
        const dev = $("btDevig") && $("btDevig").value === "1";
        const affiche = dev ? (r.edge_devig ?? r.edge) : r.edge;
        const autre = dev ? r.edge : (r.edge_devig ?? r.edge);
        const divergent = autre != null && (affiche < 0) !== (autre < 0);
        const note = divergent
          ? `<span class="edge-alt" title="${dev ? "edge brut" : "edge après retrait de la marge"} : ${fmtPct(autre)}">${dev ? "brut" : "dévig."} ${fmtPct(autre)}</span>`
          : "";
        return `<td data-label="Edge" class="num ${affiche >= 0 ? 'pos' : 'neg'}">${fmtPct(affiche)}${note}</td>`;
      })()}
      <td data-label="Issue">${r.gagne ? '<span class="pos">Gagné</span>' : '<span class="neg">Perdu</span>'}</td>
      <td data-label="Gain/perte" class="num ${gain>=0?'pos':'neg'}">${fmtEur(gain)}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="9" class="muted">Aucun pari ne correspond à ce filtre.</td></tr>';
  $("btRowInfo").textContent = `${rows.length} pari(s)` + (rows.length > 400 ? " (400 affichés)" : "");

  // Indique visuellement la colonne triée
  document.querySelectorAll("#btTable th.sortable").forEach(th => {
    const fleche = th.querySelector(".arrow");
    if (fleche) fleche.textContent = (th.dataset.bk === btSortKey)
      ? (btSortDir > 0 ? "▲" : "▼") : "";
  });

  attachDcTooltips();
}

// --- Export CSV du tableau "Détail des paris testés" --------------------
// La feuille « Paris testés » du classeur Excel (write_backtest_xlsx côté
// Python) est un dump LARGE : elle ne filtre que sur un seuil d'edge lâche
// (brut OU dévigué >= 2 %) et n'a même pas de colonne Espérance — elle ne
// contient ni le dédoublonnage « un seul par match et catégorie », ni les
// corrections calibration/xG/mélange marché, ni la mise Kelly. Reproduire
// « les mêmes filtres » à la main dans Excel à partir de là ne peut PAS
// retomber sur les mêmes résultats que le site : la matière première n'est
// pas la même, et c'est justement ce qui avait faussé une analyse plus tôt
// dans cette conversation.
//
// Ce bouton exporte à la place EXACTEMENT ce que btFiltered() retient sous
// les filtres actuellement affichés à l'écran — la même fonction que celle
// qui alimente les KPI, le graphique et le tableau de cette page. Il ne
// peut donc pas exister d'écart entre le CSV et ce qui est affiché : c'est
// littéralement les mêmes données, au même instant.
function exporterBacktestCsv() {
  const devigActif = $("btDevig") && $("btDevig").value === "1";
  // Tri chronologique, indépendant du tri courant du tableau à l'écran (qui
  // peut être sur n'importe quelle colonne) — un ordre stable et prévisible
  // pour un fichier destiné à être retravaillé dans Excel.
  const rows = btFiltered().slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const fb = $("btExportFeedback");
  if (!rows.length) {
    if (fb) fb.textContent = "Aucun pari à exporter avec les filtres actuels.";
    return;
  }

  // Point-virgule (pas virgule) : Excel en français scinde une colonne au
  // point-virgule, la virgule étant déjà le séparateur décimal.
  const champ = v => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[;"\n]/.test(s) ? `"${s}"` : s;
  };
  const pct = v => (v == null ? "" : (v * 100).toFixed(1) + "%");
  const num = v => (v == null ? "" : v.toFixed(2));

  // Reprend AU MOINS toutes les colonnes de la feuille « Paris testés » du
  // classeur Excel (mêmes intitulés, pour s'y retrouver), plus l'Espérance
  // — absente du classeur, alors que c'est justement l'un des filtres qui
  // fait diverger le site d'un filtrage manuel dans Excel — et la mise/le
  // gain réellement appliqués ici (fixe ou Kelly selon "Stratégie de mise").
  const entetes = [
    "Date", "Match", "Pays", "Ligue", "Catégorie", "Pari", "Cote",
    "Proba modèle", "Proba modèle (xG)",
    "Edge brut", "Edge brut (xG)", "Edge dévigué", "Edge dévigué (xG)",
    "Espérance", "Espérance (xG)", "Marge marché",
    "Score réel", "Gagné", "Profit (unités)",
    "Buts att. dom.", "Buts att. dom. (xG)", "Buts att. ext.", "Buts att. ext. (xG)",
    "Force att. dom.", "Force déf. dom.", "Force att. ext.", "Force déf. ext.",
    "Hist. dom.", "Hist. ext.",
    "Cote ouverture", "Variation proba", "A raccourci", "Nb captures",
    "Edge affiché (site)", "Mise (€)", "Gain/perte (€)",
  ];
  const lignes = rows.map(r => {
    // appliquerXg() (voir plus haut) substitue p_model/edge/edge_devig/
    // lam_home/lam_away par leur lecture xG QUAND elle est active, en
    // sauvegardant l'originale "en buts" dans *_buts — sauf pour l'espérance,
    // qui n'a pas de sauvegarde dédiée : on la recalcule nous-mêmes avec la
    // même formule qu'ailleurs dans ce fichier (ev = p·(cote−1) − (1−p)),
    // pour offrir les DEUX lectures ici comme pour proba/edge.
    const probaButs = r.p_model_buts ?? r.p_model;
    const probaXg = r.p_model_xg;
    const edgeButs = r.edge_buts ?? r.edge;
    const edgeXg = r.edge_xg;
    const edgeDevigButs = r.edge_devig_buts ?? r.edge_devig;
    const edgeDevigXg = r.edge_devig_xg;
    const lamHomeButs = r.lam_home_buts ?? r.lam_home;
    const lamHomeXg = r.lam_home_xg;
    const lamAwayButs = r.lam_away_buts ?? r.lam_away;
    const lamAwayXg = r.lam_away_xg;
    const evButs = probaButs != null ? probaButs * (r.cote - 1) - (1 - probaButs) : null;
    const evXg = probaXg != null ? probaXg * (r.cote - 1) - (1 - probaXg) : null;

    // Même lecture d'edge que la colonne "Edge" du tableau juste au-dessus
    // (celle du mode actif, brut ou dévigué) — utile pour vérifier d'un
    // coup d'œil laquelle des deux a fait passer le pari sous ce filtre.
    const edgeAffiche = devigActif ? (r.edge_devig ?? r.edge) : r.edge;
    // Même mise que la colonne "Gain/perte" du tableau : suit la stratégie
    // choisie dans "Stratégie de mise" (fixe ou Kelly).
    const mise = btStakeFor(r);
    const gain = r.profit * mise;

    return [
      r.date, r.match, r.pays || "", r.ligue || "", r.categorie, r.colonne,
      num(r.cote),
      pct(probaButs), pct(probaXg),
      pct(edgeButs), pct(edgeXg), pct(edgeDevigButs), pct(edgeDevigXg),
      pct(evButs), pct(evXg), pct(r.marge_marche),
      r.score_reel, r.gagne ? "Oui" : "Non", num(r.profit),
      num(lamHomeButs), num(lamHomeXg), num(lamAwayButs), num(lamAwayXg),
      num(r.force_att_dom), num(r.force_def_dom), num(r.force_att_ext), num(r.force_def_ext),
      r.n_hist_dom ?? "", r.n_hist_ext ?? "",
      num(r.cote_ouverture), pct(r.variation_proba),
      r.raccourcit == null ? "" : (r.raccourcit ? "Oui" : "Non"), r.n_captures ?? "",
      pct(edgeAffiche), num(mise), num(gain),
    ].map(champ).join(";");
  });
  // ﻿ (BOM) : sans lui, Excel Windows interprète les caractères
  // accentués du fichier comme du Latin-1 et affiche "Ã©" au lieu de "é".
  const csv = "﻿" + entetes.join(";") + "\n" + lignes.join("\n");
  const blob = new Blob([csv], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wina_wizard_filtre_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  if (fb) {
    fb.textContent = `${rows.length} pari(s) exporté(s) — exactement ceux retenus par les filtres actuels de cette page.`;
    setTimeout(() => { fb.textContent = ""; }, 7000);
  }
}
(function initExportBacktestCsv() {
  const btn = $("btExportCsv");
  if (btn) btn.addEventListener("click", exporterBacktestCsv);
})();

/* Infobulle détaillant les paramètres du modèle pour un match donné :
   comprendre POURQUOI il a misé là, et avec quelle solidité d'historique. */
function attachDcTooltips() {
  let tip = document.getElementById("dcTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "dcTip";
    tip.className = "dc-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  document.querySelectorAll(".dc-match").forEach(el => {
    el.addEventListener("mouseenter", e => {
      let d;
      try { d = JSON.parse(decodeURIComponent(el.dataset.dc)); } catch { return; }
      if (d.lh == null) { return; }   // pari sans paramètres (données anciennes)

      const fiable = n => (n >= 10 ? "" : ' <span class="dc-warn">⚠ peu d\'historique</span>');

      // Tirs cadrés : n'apparaît que si api_football_collect.py les a
      // ramenés pour ce match précis. Lecture en clair plutôt qu'un simple
      // nombre : ce qui compte, c'est si le score reflète le jeu produit.
      let blocTirs = "";
      if (d.tcd != null && d.tce != null) {
        let lecture, classe;
        if (d.ecf > 0.5) { lecture = "Ont sur-converti"; classe = "pos"; }
        else if (d.ecf < -0.5) { lecture = "Ont gâché"; classe = "neg"; }
        else { lecture = "Finition conforme au jeu produit"; classe = ""; }
        blocTirs = `
        <div class="dc-tip-sep"></div>
        <div class="dc-tip-row"><span>Tirs cadrés</span><strong>${d.tcd} – ${d.tce}</strong></div>
        <div class="dc-tip-row"><span>Buts attendus (selon tirs)</span><strong>≈ ${d.bst}</strong></div>
        <div class="dc-tip-row"><span>Lecture</span><strong class="${classe}">${lecture}</strong></div>`;
      }

      tip.innerHTML = `
        <div class="dc-tip-head">${d.m}</div>
        <div class="dc-tip-row"><span>Buts attendus (modèle)</span>
          <strong>${d.lhb} – ${d.lab}</strong></div>
        ${d.lhx != null ? `
        <div class="dc-tip-row"><span>Buts attendus (mélange xG)</span>
          <strong class="pos">${d.lhx} – ${d.lax}</strong></div>` : ""}
        <div class="dc-tip-sep"></div>
        <div class="dc-tip-row"><span>Domicile · attaque</span><strong>${d.ad}</strong></div>
        <div class="dc-tip-row"><span>Domicile · défense</span><strong>${d.dd}</strong></div>
        <div class="dc-tip-row"><span>Extérieur · attaque</span><strong>${d.ae}</strong></div>
        <div class="dc-tip-row"><span>Extérieur · défense</span><strong>${d.de}</strong></div>
        <div class="dc-tip-sep"></div>
        <div class="dc-tip-row"><span>Matchs d'historique</span>
          <strong>${d.nd} / ${d.ne}</strong>${fiable(Math.min(d.nd, d.ne))}</div>
        <div class="dc-tip-row"><span>Score réel</span><strong>${d.sc}</strong></div>${blocTirs}
        <div class="dc-tip-note">1,00 = moyenne de la ligue. Attaque &gt; 1 = marque plus ;
          défense &lt; 1 = encaisse moins.${d.lhx != null
            ? ' Le mélange xG est affiché ici quel que soit le mode actif de la page.' : ''}</div>`;
      tip.hidden = false;

      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth || 240, th = tip.offsetHeight || 200;
      let left = r.left + window.scrollX;
      let top = r.bottom + window.scrollY + 8;
      if (left + tw > window.innerWidth - 12) left = window.innerWidth - tw - 12;
      // Bascule au-dessus si ça déborderait en bas de l'écran
      if (r.bottom + th + 20 > window.innerHeight) top = r.top + window.scrollY - th - 8;
      tip.style.left = Math.max(8, left) + "px";
      tip.style.top = Math.max(8, top) + "px";
    });
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}

// Tri au clic sur les en-têtes du tableau de détail
document.querySelectorAll("#btTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.bk;
    if (!k) return;
    if (btSortKey === k) btSortDir *= -1;
    else { btSortKey = k; btSortDir = (k === "match" || k === "date") ? 1 : -1; }
    renderBacktestRows();
  });
});

/* ============================================================
   VALIDATION OUT-OF-SAMPLE
   ------------------------------------------------------------
   Le vrai danger de cette page : elle offre une soixantaine de
   combinaisons de réglages (marge, paris liés, poids du modèle,
   seuil d'edge, catégorie). Les essayer toutes sur le même jeu
   de paris pour garder la meilleure, c'est du surapprentissage
   garanti — sur un échantillon modeste, au moins une paraîtra
   excellente par pur hasard.

   Parade : on coupe les paris en deux moitiés chronologiques.
   Vous réglez en regardant la première (apprentissage), et le
   tableau affiche ce que CE MÊME réglage aurait donné sur la
   seconde (test), que vous n'avez pas utilisée pour choisir.
   Un réglage qui survit mérite un peu de confiance ; un réglage
   qui s'effondre était une illusion.
   ============================================================ */

function renderOosValidation() {
  const box = $("btOos");
  if (!box) return;

  const rows = btFiltered().slice().sort((a, b) => a.date.localeCompare(b.date));
  const stake = btStake();

  if (rows.length < 8) {
    box.innerHTML = '<p class="muted">Pas assez de paris pour couper en deux périodes.</p>';
    return;
  }

  const coupe = Math.floor(rows.length / 2);
  const app = rows.slice(0, coupe);      // apprentissage : ce que vous regardez
  const test = rows.slice(coupe);        // test : jamais utilisé pour régler
  const aApp = btAgg(app), aTest = btAgg(test);

  // Verdict. Volontairement prudent : sur de petits échantillons, un écart
  // entre les deux moitiés est le plus souvent du bruit, pas un signal.
  let cls = "neutre", titre, texte;
  if (aTest.n < 20) {
    titre = "Échantillon de test trop petit pour conclure.";
    texte = `Seulement ${aTest.n} pari(s) dans la seconde moitié. Il en faudrait plusieurs ` +
      `dizaines pour que cette comparaison ait un sens.`;
  } else if (aApp.roi > 0 && aTest.roi > 0) {
    cls = "bon";
    titre = "L'avantage tient sur la période de test.";
    texte = `ROI de ${fmtPct(aApp.roi)} sur l'apprentissage, ${fmtPct(aTest.roi)} sur des paris ` +
      `que ce réglage n'a jamais servi à choisir. C'est le meilleur signe disponible — sans être ` +
      `une garantie : il reste ${test.length} paris, et vous avez essayé plusieurs réglages.`;
  } else if (aApp.roi > 0 && aTest.roi <= 0) {
    cls = "mauvais";
    titre = "L'avantage disparaît en test — surapprentissage probable.";
    texte = `${fmtPct(aApp.roi)} sur l'apprentissage, mais ${fmtPct(aTest.roi)} sur la période de ` +
      `test. Ce réglage colle au passé sans capturer quoi que ce soit de durable. C'est exactement ` +
      `le piège que cette section sert à détecter.`;
  } else if (aApp.roi <= 0 && aTest.roi > 0) {
    titre = "Résultats contradictoires entre les deux périodes.";
    texte = `${fmtPct(aApp.roi)} puis ${fmtPct(aTest.roi)}. Un tel écart traduit surtout la ` +
      `variance : rien de solide à en tirer dans un sens ou dans l'autre.`;
  } else {
    cls = "mauvais";
    titre = "Perdant sur les deux périodes.";
    texte = `${fmtPct(aApp.roi)} puis ${fmtPct(aTest.roi)}. Au moins le résultat est cohérent — ` +
      `ce réglage ne fonctionne pas, et ce n'est pas un accident d'échantillonnage.`;
  }

  const bloc = (nom, a, periode) => `
    <div class="oos-half">
      <div class="oos-label">${nom}</div>
      <div class="oos-periode">${periode}</div>
      <div class="oos-roi ${a.roi >= 0 ? 'pos' : 'neg'}">${fmtPct(a.roi)}</div>
      <div class="oos-meta">${a.n} paris · ${a.wins} gagnés · ${fmtEur(a.profit * stake)}</div>
    </div>`;

  box.innerHTML = `
    <div class="oos-grid">
      ${bloc("Apprentissage", aApp, `${app[0].date} → ${app[app.length-1].date}`)}
      <div class="oos-arrow" aria-hidden="true">→</div>
      ${bloc("Test", aTest, `${test[0].date} → ${test[test.length-1].date}`)}
    </div>
    <div class="verdict-box ${cls}" style="margin-top:1rem">
      <strong>${titre}</strong> ${texte}
    </div>`;
}

/* Diagnostic : la binomiale négative calibre-t-elle mieux que Poisson ?
   Purement informatif — n'affecte jamais p_model/edge/ev, calculés par
   Python côté serveur toujours en Poisson. Voir estimer_dispersion_nbinom
   et valider_nbinom dans wina_wizard.py pour la méthodologie. */
function renderNbValidation() {
  const box = $("btNbValid");
  if (!box) return;
  const v = BT_STATS.nb_validation;

  if (!v) {
    box.innerHTML = '<p class="muted">En attente de données.</p>';
    return;
  }
  if (v.insuffisant || !v.r_estime) {
    const nm = v.n_matchs != null ? v.n_matchs : 0;
    box.innerHTML = `<p class="muted">Pas assez de matchs testés pour trancher (${nm}, il en ` +
      `faut environ 100) — ou aucune survariance détectable pour l'instant : Poisson colle déjà ` +
      `à la variance observée sur ce backtest.</p>`;
    return;
  }

  const brierGagne = v.brier_nbinom < v.brier_poisson;
  const bloc = (nom, valeur, sousTexte, gagne) => `
    <div class="oos-half">
      <div class="oos-label">${nom}</div>
      <div class="oos-periode">${sousTexte}</div>
      <div class="oos-roi ${gagne ? 'pos' : ''}">${valeur}</div>
    </div>`;

  const ratioTxt = v.calib_ratio_nbinom != null
    ? `· ratio de calibration NB ${v.calib_ratio_nbinom.toFixed(3)}` +
      (CALIB_RATIO ? ` (Poisson : ${CALIB_RATIO.toFixed(3)}, cible 1.0)` : "")
    : "";

  box.innerHTML = `
    <div class="oos-grid">
      ${bloc("Poisson (actif)", v.brier_poisson.toFixed(5), "score de Brier — plus bas = mieux calibré", !brierGagne)}
      <div class="oos-arrow" aria-hidden="true">vs</div>
      ${bloc("Binomiale négative", v.brier_nbinom.toFixed(5), `r estimé = ${v.r_estime}`, brierGagne)}
    </div>
    <p class="muted" style="margin-top:.8rem; font-size:.85rem">
      ${v.n_paris} paris testés
      · gain de Brier ${v.brier_gain_pct != null ? (v.brier_gain_pct > 0 ? "+" : "") + v.brier_gain_pct + " %" : "—"}
      · favorable dans ${v.favorable_bootstrap_pct} % des tirages bootstrap
      ${ratioTxt}
    </p>
    <div class="verdict-box ${v.concluant ? "bon" : "neutre"}" style="margin-top:.8rem">
      <strong>${v.concluant ? "Amélioration nette et stable." : "Pas encore concluant."}</strong>
      ${v.conclusion} La loi active reste Poisson : ce panneau est un diagnostic, pas un
      changement automatique de modèle.
    </div>`;
}

/* Comparaison : suivre le mouvement du marché est-il rentable ? */
function renderMouvement() {
  const box = $("btMvtStats");
  if (!box) return;
  const m = BT_STATS.mouvement;

  if (!m || !m.n_total) {
    box.innerHTML = `<p class="muted">Aucun pari ne dispose encore de plusieurs captures avant
      son coup d'envoi. Pour mesurer un mouvement, il faut que la collecte tourne au moins deux
      fois avant un même match — par exemple une capture à 2 h et une seconde en fin d'après-midi,
      quand les compositions filtrent et que le marché bouge le plus.</p>`;
    return;
  }

  const r = m.raccourcies, a = m.allongees;
  const carte = (titre, s, cls, note) => `
    <div class="oos-half">
      <div class="oos-label">${titre}</div>
      <div class="oos-periode">${note}</div>
      <div class="oos-roi ${s.roi >= 0 ? 'pos' : 'neg'}">${s.roi != null ? fmtPct(s.roi) : "—"}</div>
      <div class="oos-meta">${s.n} paris · ${s.taux != null ? (s.taux*100).toFixed(0) + "% de réussite" : "—"}</div>
    </div>`;

  let tranches = "";
  if (m.tranches && m.tranches.length) {
    tranches = `<div class="cote-rows" style="margin-top:1.2rem">` + m.tranches.map(t => {
      const maxAbs = Math.max(0.2, ...m.tranches.map(x => Math.abs(x.roi || 0)));
      const largeur = Math.min(50, Math.abs(t.roi || 0) / maxAbs * 50);
      const pos = (t.roi || 0) >= 0;
      return `
        <div class="cote-row">
          <div class="cote-label">${t.label}</div>
          <div class="cote-track">
            <div class="cote-axis"></div>
            <div class="cote-fill ${pos ? 'pos' : 'neg'}"
                 style="${pos ? 'left:50%' : 'right:50%'}; width:${largeur.toFixed(1)}%"></div>
          </div>
          <div class="cote-val ${pos ? 'pos' : 'neg'}">${fmtPct(t.roi)}</div>
          <div class="cote-meta">${t.n} paris${t.n < 20 ? " ⚠" : ""}<br>
            <span class="muted">${(t.taux*100).toFixed(0)} % de réussite</span></div>
        </div>`;
    }).join("") + `</div>`;
  }

  // --- Le marché bat-il le modèle ? ---
  let duel = "";
  if (m.top_marche && m.top_modele && m.top_marche.n >= 10) {
    const tm = m.top_marche, td = m.top_modele;
    const gagnant = tm.roi > td.roi ? "marché" : "modèle";
    duel = `
      <div class="duel-grid">
        <div class="duel-half ${gagnant === "marché" ? "gagne" : ""}">
          <div class="oos-label">Sélection par le MARCHÉ</div>
          <div class="oos-periode">les ${m.taille_top} plus fortes baisses de cote</div>
          <div class="oos-roi ${tm.roi >= 0 ? 'pos' : 'neg'}">${fmtPct(tm.roi)}</div>
          <div class="oos-meta">${tm.n} paris · ${(tm.taux*100).toFixed(0)} % de réussite</div>
        </div>
        <div class="duel-half ${gagnant === "modèle" ? "gagne" : ""}">
          <div class="oos-label">Sélection par le MODÈLE</div>
          <div class="oos-periode">les ${m.taille_top} plus gros edges</div>
          <div class="oos-roi ${td.roi >= 0 ? 'pos' : 'neg'}">${fmtPct(td.roi)}</div>
          <div class="oos-meta">${td.n} paris · ${(td.taux*100).toFixed(0)} % de réussite</div>
        </div>
      </div>`;
  }

  // --- Significativité statistique ---
  let signif = "";
  if (m.z_raccourcies != null) {
    const z = m.z_raccourcies;
    const fort = Math.abs(z) > 2;
    signif = `<p class="muted" style="margin-top:.9rem;font-size:.82rem">
      <strong>Test statistique :</strong> les cotes qui raccourcissent s'écartent de
      ${z >= 0 ? "+" : ""}${z} écarts-types de ce que le modèle attendait.
      ${fort ? "C'est un écart marqué, peu susceptible d'être dû au hasard."
             : "C'est dans la plage du hasard : rien de concluant."}
    </p>`;
  }

  // --- Détail par catégorie ---
  let parCat = "";
  if (m.par_categorie && Object.keys(m.par_categorie).length) {
    const lignes = Object.entries(m.par_categorie).map(([cat, v]) => `
      <tr>
        <td data-label="Catégorie"><strong>${cat}</strong></td>
        <td data-label="Raccourcies" class="num">${v.raccourcies.n}</td>
        <td data-label="ROI" class="num ${v.raccourcies.roi >= 0 ? 'pos':'neg'}">${v.raccourcies.roi != null ? fmtPct(v.raccourcies.roi) : "—"}</td>
        <td data-label="Allongées" class="num">${v.allongees.n}</td>
        <td data-label="ROI " class="num ${v.allongees.roi >= 0 ? 'pos':'neg'}">${v.allongees.roi != null ? fmtPct(v.allongees.roi) : "—"}</td>
      </tr>`).join("");
    parCat = `
      <h3 class="sub-h">Par catégorie de pari</h3>
      <div class="tablewrap">
        <table class="cardify">
          <thead><tr>
            <th>Catégorie</th>
            <th class="num">Raccourcies</th><th class="num">ROI</th>
            <th class="num">Allongées</th><th class="num">ROI</th>
          </tr></thead>
          <tbody>${lignes}</tbody>
        </table>
      </div>`;
  }

  // Contexte sur l'amplitude : des captures trop rapprochées ne montrent rien
  let contexte = "";
  if (m.amplitude_moyenne != null) {
    const amp = m.amplitude_moyenne * 100;
    contexte = `<p class="muted" style="margin-top:.6rem;font-size:.8rem">
      Amplitude moyenne du mouvement : ${amp.toFixed(1)} point(s) de probabilité
      ${m.heures_moyennes ? `sur ${m.heures_moyennes} h entre la première et la dernière capture` : ""}.
      ${amp < 1 ? "C'est très faible — vos captures sont probablement trop rapprochées pour que le marché ait eu le temps de bouger." : ""}
    </p>`;
  }

  // Verdict, volontairement prudent sur les petits échantillons
  let verdict = "";
  if (r.n >= 20 && a.n >= 20 && r.roi != null && a.roi != null) {
    const ecart = (r.roi - a.roi) * 100;
    if (ecart > 15) {
      verdict = `<div class="verdict-box bon" style="margin-top:1rem"><strong>Le marché porte
        un vrai signal.</strong> Les cotes qui raccourcissent rapportent ${ecart.toFixed(0)} points
        de plus que celles qui s'allongent. Filtrer sur « a raccourci » dans les réglages ci-dessus
        pour voir ce que ça donnerait sur l'ensemble des indicateurs.</div>`;
    } else if (ecart < -15) {
      verdict = `<div class="verdict-box mauvais" style="margin-top:1rem"><strong>Signal inversé —
        méfiance.</strong> Les cotes qui s'allongent rapportent davantage, ce qui est contre-intuitif
        et suggère plutôt un artefact de l'échantillon qu'un phénomène réel.</div>`;
    } else {
      verdict = `<div class="verdict-box neutre" style="margin-top:1rem"><strong>Pas d'écart
        marqué.</strong> ${ecart >= 0 ? "+" : ""}${ecart.toFixed(0)} points entre les deux groupes :
        le mouvement de la cote ne semble pas porter d'information exploitable ici.</div>`;
    }
  } else {
    verdict = `<div class="verdict-box neutre" style="margin-top:1rem"><strong>Échantillon
      insuffisant pour conclure.</strong> ${r.n} paris avec cote en baisse, ${a.n} en hausse.
      Il en faudrait au moins une vingtaine de chaque côté.</div>`;
  }

  box.innerHTML = `
    <div class="oos-grid">
      ${carte("Cote qui a raccourci", r, "", "le marché y croit davantage")}
      <div class="oos-arrow" aria-hidden="true">vs</div>
      ${carte("Cote qui s'est allongée", a, "", "le marché s'en détourne")}
    </div>
    ${tranches}
    ${verdict}
    ${signif}
    ${contexte}
    ${duel ? `<h3 class="sub-h">Qui sélectionne le mieux : le marché ou le modèle ?</h3>
      <p class="muted" style="margin:-.3rem 0 .8rem;font-size:.83rem">
        Même nombre de paris de chaque côté, choisis selon deux critères opposés.
        Si le marché l'emporte nettement, le modèle n'apporte rien.</p>${duel}` : ""}
    ${parCat}
    <p class="muted" style="margin-top:.8rem;font-size:.8rem">
      Mesuré sur ${m.n_total} pari(s) disposant d'au moins deux captures. ⚠ = moins de 20 paris.
    </p>`;
}

/* ---------- Diagnostics visuels du modèle ---------- */

function drawCalibration() {
  const wrap = $("btCalibWrap");
  // Calibration recalculée sur l'ensemble filtré (la déduplication modifie
  // la répartition par tranche de probabilité).
  const tranches = [[0,.05],[.05,.10],[.10,.20],[.20,.35],[.35,.50],[.50,.70],[.70,1.01]];
  const src = btFiltered();
  const data = tranches.map(([lo,hi]) => {
    const sub = src.filter(r => r.p_model >= lo && r.p_model < hi);
    if (!sub.length) return null;
    const predit = sub.reduce((s,r) => s + r.p_model, 0) / sub.length;
    const reel = sub.filter(r => r.gagne).length / sub.length;
    return {tranche: `${Math.round(lo*100)}-${Math.round(hi*100)} %`,
            predit, reel, n: sub.length, ecart: reel - predit};
  }).filter(d => d && d.n >= 3);
  if (!wrap) return;
  if (!data.length) {
    wrap.innerHTML = '<p class="muted">Pas encore assez de paris pour évaluer la calibration.</p>';
    $("btCalibVerdict").style.display = "none";
    return;
  }

  const W = 640, H = 380, pad = 52;
  const sx = p => pad + p * (W - pad * 1.4);
  const sy = p => H - pad - p * (H - pad * 1.5);

  // Grille + diagonale de référence (calibration parfaite)
  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const v = i / 5;
    grid += `<line x1="${sx(v).toFixed(1)}" y1="${sy(0).toFixed(1)}" x2="${sx(v).toFixed(1)}" y2="${sy(1).toFixed(1)}" stroke="var(--line-soft)" opacity=".5"/>
      <line x1="${sx(0).toFixed(1)}" y1="${sy(v).toFixed(1)}" x2="${sx(1).toFixed(1)}" y2="${sy(v).toFixed(1)}" stroke="var(--line-soft)" opacity=".5"/>
      <text x="${sx(v).toFixed(1)}" y="${(H - pad + 18).toFixed(1)}" text-anchor="middle" class="chart-tip" fill="var(--ink-faint)">${(v*100).toFixed(0)}%</text>
      <text x="${(pad - 10).toFixed(1)}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end" class="chart-tip" fill="var(--ink-faint)">${(v*100).toFixed(0)}%</text>`;
  }

  const maxN = arrMax(data.map(d => d.n));
  const points = data.map(d => {
    const r = 4 + 9 * Math.sqrt(d.n / maxN);      // aire ∝ nombre de paris
    const bon = Math.abs(d.ecart) < 0.05;
    const couleur = bon ? "var(--up)" : (d.ecart < 0 ? "var(--down)" : "var(--cyan)");
    return `<circle cx="${sx(d.predit).toFixed(1)}" cy="${sy(d.reel).toFixed(1)}" r="${r.toFixed(1)}"
              fill="${couleur}" fill-opacity=".3" stroke="${couleur}" stroke-width="1.5">
              <title>${d.tranche} · ${d.n} paris · annoncé ${(d.predit*100).toFixed(1)}% · réel ${(d.reel*100).toFixed(1)}%</title>
            </circle>`;
  }).join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="diag-svg" role="img" aria-label="Courbe de calibration">
      ${grid}
      <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}"
            stroke="var(--ink-faint)" stroke-dasharray="5 4" stroke-width="1.5"/>
      <text x="${sx(0.72)}" y="${sy(0.78)}" class="chart-tip" fill="var(--ink-faint)"
            transform="rotate(-38 ${sx(0.72)} ${sy(0.78)})">calibration parfaite</text>
      ${points}
      <text x="${(W/2).toFixed(0)}" y="${H - 8}" text-anchor="middle" class="chart-tip" fill="var(--ink-dim)">Probabilité annoncée par le modèle</text>
      <text x="14" y="${(H/2).toFixed(0)}" text-anchor="middle" class="chart-tip" fill="var(--ink-dim)"
            transform="rotate(-90 14 ${(H/2).toFixed(0)})">Fréquence réelle observée</text>
    </svg>`;

  // Verdict : biais moyen pondéré par le nombre de paris
  const poids = data.reduce((s, d) => s + d.n, 0);
  const biais = data.reduce((s, d) => s + d.n * d.ecart, 0) / poids;
  const vb = $("btCalibVerdict");
  let cls = "neutre", txt = "";
  if (poids < 50) {
    txt = `<strong>Trop peu de paris (${poids}) pour juger la calibration.</strong> Les écarts que ` +
          `vous voyez sont dominés par le hasard. Il faut plusieurs centaines de paris pour que cette ` +
          `courbe devienne informative.`;
  } else if (biais < -0.04) {
    cls = "mauvais";
    txt = `<strong>Le modèle surestime ses probabilités de ${Math.abs(biais*100).toFixed(1)} points en moyenne.</strong> ` +
          `C'est la cause la plus probable d'un backtest décevant : il croit voir de la valeur là où ` +
          `il n'y en a pas. Relever le seuil d'edge minimum compenserait en partie ce biais.`;
  } else if (biais > 0.04) {
    cls = "bon";
    txt = `<strong>Le modèle sous-estime ses probabilités de ${(biais*100).toFixed(1)} points.</strong> ` +
          `Plus rare, et plutôt bon signe : ses value bets sont probablement conservateurs.`;
  } else {
    cls = "bon";
    txt = `<strong>Calibration correcte</strong> (biais moyen ${(biais*100).toFixed(1)} points sur ${poids} paris). ` +
          `Les probabilités annoncées correspondent à peu près à la réalité.`;
  }
  vb.className = "verdict-box " + cls;
  vb.innerHTML = txt;
  vb.style.display = "";
}

function drawParCote() {
  const wrap = $("btCoteWrap");
  const gammes = [[1,1.5],[1.5,2],[2,3],[3,5],[5,10],[10,1000]];
  const srcCote = btFiltered();
  const data = gammes.map(([lo,hi]) => {
    const sub = srcCote.filter(r => r.cote >= lo && r.cote < hi);
    if (!sub.length) return null;
    const a = btAgg(sub);
    return {gamme: hi < 1000 ? `${lo}–${hi}` : `${lo}+`,
            n: a.n, roi: a.roi, taux: a.taux, attendu: a.wins_attendus / a.n};
  }).filter(Boolean);
  if (!wrap) return;
  if (!data.length) {
    wrap.innerHTML = '<p class="muted">Pas encore de paris à répartir par gamme de cotes.</p>';
    return;
  }

  const maxAbs = Math.max(0.2, ...data.map(d => Math.abs(d.roi)));
  wrap.innerHTML = `<div class="cote-rows">` + data.map(d => {
    const largeur = Math.min(50, Math.abs(d.roi) / maxAbs * 50);
    const positif = d.roi >= 0;
    const fiable = d.n >= 20;
    return `
      <div class="cote-row">
        <div class="cote-label">Cote ${d.gamme}</div>
        <div class="cote-track">
          <div class="cote-axis"></div>
          <div class="cote-fill ${positif ? 'pos' : 'neg'}"
               style="${positif ? 'left:50%' : `right:50%`}; width:${largeur.toFixed(1)}%"></div>
        </div>
        <div class="cote-val ${positif ? 'pos' : 'neg'}">${fmtPct(d.roi)}</div>
        <div class="cote-meta">${d.n} paris${fiable ? "" : " ⚠"}<br>
          <span class="muted">${(d.taux*100).toFixed(0)}% réussite / ${(d.attendu*100).toFixed(0)}% attendu</span>
        </div>
      </div>`;
  }).join("") + `</div>
    <p class="muted" style="margin-top:.7rem;font-size:.8rem">⚠ = moins de 20 paris, résultat peu fiable.</p>`;
}

// Lecture des pertes par les tirs cadrés. Le modèle raisonne en buts, un
// événement rare et bruité ; les tirs cadrés sont ~3x plus fréquents, donc
// bien plus stables. En comparant les buts réellement marqués aux buts
// attendus d'après les tirs, on sépare deux causes de perte que le seul
// résultat confond : une mauvaise estimation du modèle, et une simple
// malchance à la finition.
//
// Le panneau reste masqué tant qu'api_football_collect.py n'a pas ramené
// de stats : sans données, mieux vaut ne rien afficher qu'un tableau vide.
function drawShotsAnalysis() {
  const panel = $("btShotsPanel");
  const wrap = $("btShotsWrap");
  if (!panel || !wrap) return;

  const src = btFiltered().filter(r => r.ecart_finition != null);
  const matchs = new Set(src.map(r => r.match + r.date)).size;
  if (src.length < 10) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";

  // Trois groupes de finition : les équipes ont gâché, converti normalement,
  // ou sur-converti. Le seuil de ±0,5 but correspond à un écart de l'ordre
  // d'un but sur le match, au-delà du bruit de mesure.
  const groupes = [
    {label: "Ont gâché",      test: r => r.ecart_finition < -0.5,
     aide: "moins de buts que le jeu produit"},
    {label: "Finition normale", test: r => r.ecart_finition >= -0.5 && r.ecart_finition <= 0.5,
     aide: "buts conformes aux tirs cadrés"},
    {label: "Ont sur-converti", test: r => r.ecart_finition > 0.5,
     aide: "plus de buts que le jeu produit"},
  ];

  const data = groupes.map(g => {
    const sub = src.filter(g.test);
    if (!sub.length) return null;
    const a = btAgg(sub);
    return {label: g.label, aide: g.aide, n: a.n, roi: a.roi, taux: a.taux,
            attendu: a.wins_attendus / a.n};
  }).filter(Boolean);

  if (!data.length) {
    wrap.innerHTML = '<p class="muted">Pas encore assez de matchs avec tirs cadrés.</p>';
    return;
  }

  const maxAbs = Math.max(0.2, ...data.map(d => Math.abs(d.roi)));
  wrap.innerHTML = `<div class="cote-rows">` + data.map(d => {
    const largeur = Math.min(50, Math.abs(d.roi) / maxAbs * 50);
    const positif = d.roi >= 0;
    const fiable = d.n >= 20;
    return `
      <div class="cote-row">
        <div class="cote-label">${d.label}<br><span class="muted" style="font-size:.72rem">${d.aide}</span></div>
        <div class="cote-track">
          <div class="cote-axis"></div>
          <div class="cote-fill ${positif ? 'pos' : 'neg'}"
               style="${positif ? 'left:50%' : `right:50%`}; width:${largeur.toFixed(1)}%"></div>
        </div>
        <div class="cote-val ${positif ? 'pos' : 'neg'}">${fmtPct(d.roi)}</div>
        <div class="cote-meta">${d.n} paris${fiable ? "" : " ⚠"}<br>
          <span class="muted">${(d.taux*100).toFixed(0)}% réussite / ${(d.attendu*100).toFixed(0)}% attendu</span>
        </div>
      </div>`;
  }).join("") + `</div>
    <p class="muted" style="margin-top:.7rem;font-size:.8rem">
      ⚠ = moins de 20 paris, résultat peu fiable.
      Mesuré sur ${src.length} pari(s) répartis sur ${matchs} match(s) disposant de tirs cadrés.
    </p>`;

  // Verdict. Le point d'intérêt n'est pas le ROI de chaque groupe pris
  // isolément, mais l'ÉCART entre eux : s'il est large, le résultat des
  // paris dépend surtout de la finition — donc d'un hasard que le modèle
  // ne peut pas anticiper, et non d'une erreur d'estimation de sa part.
  const vb = $("btShotsVerdict");
  if (vb && data.length >= 2) {
    const rois = data.map(d => d.roi);
    const etendue = arrMax(rois) - arrMin(rois);
    let titre, texte, cls;
    if (matchs < 30) {
      cls = "neutre";
      titre = "Trop peu de matchs pour conclure.";
      texte = `Seulement ${matchs} match(s) disposent de tirs cadrés. Les écarts ci-dessus
               sont encore dominés par le hasard — la collecte quotidienne les affinera.`;
    } else if (etendue > 0.4) {
      cls = "neutre";
      titre = "Le résultat dépend surtout de la finition.";
      texte = `L'écart de ROI entre les matchs bien et mal convertis atteint
               ${(etendue*100).toFixed(0)} points. Le modèle estime donc le rapport de forces
               à peu près correctement ; ce qui décide du gain, c'est la réussite devant le
               but — un hasard qu'aucun modèle à base de buts ne peut anticiper.
               Passer les forces d'équipes aux tirs cadrés plutôt qu'aux buts attaquerait
               cette limite à sa racine.`;
    } else {
      cls = "mauvais";
      titre = "La finition n'explique pas les pertes.";
      texte = `Les trois groupes affichent des ROI proches (${(etendue*100).toFixed(0)} points
               d'écart). Les paris perdus ne le sont donc pas par malchance devant le but :
               c'est l'estimation du modèle elle-même qui est en cause.`;
    }
    vb.className = `verdict-box ${cls}`;
    vb.innerHTML = `<strong>${titre}</strong> ${texte}`;
    vb.style.display = "";
  }
}

// État de la collecte de tirs cadrés. Ce panneau ne dépend pas des filtres :
// il décrit le stock de données disponible, pas les paris affichés.
function drawShotsCoverage() {
  const panel = $("btShotsCoverPanel");
  const wrap = $("btShotsCoverWrap");
  if (!panel || !wrap) return;

  const c = WIZARD_DATA.shots_coverage || {};
  if (!c.n_matchs) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";

  const seuil = c.seuil || 6;
  const rep = c.repartition || {};
  // Barres d'avancement : combien d'équipes à 1, 2, 3... rencontres.
  const ordre = ["1", "2", "3", "4", "5", "6+"];
  const maxEq = Math.max(1, ...ordre.map(k => rep[k] || 0));
  const barres = ordre.filter(k => rep[k]).map(k => {
    const n = rep[k];
    const pret = k === "6+";
    return `
      <div class="cote-row">
        <div class="cote-label">${k} match${k === "1" ? "" : "s"}</div>
        <div class="cote-track">
          <div class="cote-axis" style="left:0"></div>
          <div class="cote-fill ${pret ? 'pos' : 'neg'}"
               style="left:0; width:${(n / maxEq * 92).toFixed(1)}%"></div>
        </div>
        <div class="cote-val ${pret ? 'pos' : ''}">${n}</div>
        <div class="cote-meta"><span class="muted">équipe${n > 1 ? "s" : ""}${pret ? " — exploitables" : ""}</span></div>
      </div>`;
  }).join("");

  const periode = c.periode
    ? `du ${c.periode[0]} au ${c.periode[1]}` : "période inconnue";
  const pret = c.equipes_pretes || 0;
  const pct = c.n_equipes ? (pret / c.n_equipes * 100) : 0;

  wrap.innerHTML = `
    <div class="scoreboard" style="margin-bottom:1rem">
      <div class="score-tile">
        <div class="st-label">Matchs avec tirs cadrés</div>
        <div class="st-value">${c.n_matchs}</div>
        <div class="st-sub">${periode}</div>
      </div>
      <div class="score-tile">
        <div class="st-label">Équipes couvertes</div>
        <div class="st-value">${c.n_equipes}</div>
        <div class="st-sub">${c.moyenne_ligue != null ? c.moyenne_ligue + " tirs cadrés / équipe / match" : "—"}</div>
      </div>
      <div class="score-tile">
        <div class="st-label">Équipes exploitables</div>
        <div class="st-value ${pret ? 'pos' : 'neg'}">${pret}</div>
        <div class="st-sub">au moins ${seuil} rencontres (${pct.toFixed(0)} %)</div>
      </div>
    </div>
    <p class="muted" style="margin:0 0 .6rem;font-size:.82rem">Répartition des équipes selon le nombre de rencontres collectées :</p>
    <div class="cote-rows">${barres}</div>`;

  const vb = document.createElement("div");
  vb.className = `verdict-box ${pret ? "bon" : "neutre"}`;
  if (!pret) {
    vb.innerHTML = `<strong>Pas encore de quoi ajuster le modèle.</strong>
      Aucune équipe n'atteint ${seuil} rencontres collectées — la médiane est à 1.
      Des forces d'attaque calculées sur si peu de matchs seraient dominées par le
      hasard et dégraderaient le modèle au lieu de l'améliorer. La collecte
      quotidienne remonte l'historique jour après jour ; le calcul s'activera de
      lui-même dès que le seuil sera franchi, sans intervention de votre part.`;
  } else {
    vb.innerHTML = `<strong>${pret} équipe(s) exploitable(s).</strong>
      Leurs forces d'attaque et de défense en tirs cadrés sont désormais calculées.
      Elles restent à valider contre le modèle actuel avant de le remplacer :
      une mesure plus stable n'est utile que si elle prédit effectivement mieux.`;
  }
  wrap.appendChild(vb);
}

function drawEvolution() {
  const wrap = $("btEvoWrap");
  if (!wrap) return;

  // Le graphique suit les MÊMES filtres que le tableau de détail : voir
  // l'évolution d'une catégorie précise ou des seuls paris gagnants est
  // souvent plus parlant que la courbe globale.
  const filtres = btFiltered().slice().sort((a, b) => a.date.localeCompare(b.date));

  if (filtres.length < 2) {
    wrap.innerHTML = '<p class="muted">Pas assez de paris pour tracer une évolution avec ces filtres.</p>';
    return;
  }

  // Recalcule le cumul sur le sous-ensemble filtré
  let cum = 0;
  const pts = filtres.map((r, i) => {
    cum += r.profit;
    // p_aff/p_model sont repris ici (et pas seulement cote/profit) car
    // btStakeFor() en a besoin pour la mise Kelly de l'infobulle au survol —
    // sans eux elle retombe silencieusement sur une mise nulle (voir plus
    // bas, gain = best.profit * btStakeFor(best)).
    return {x: i + 1, y: cum, date: r.date, match: r.match, pari: r.colonne,
            cote: r.cote, gagne: r.gagne, score: r.score_reel, profit: r.profit,
            p_aff: r.p_aff, p_model: r.p_model};
  });

  const W = 1180, H = 300, padL = 62, padR = 22, padT = 26, padB = 38;
  const ys = pts.map(p => p.y).concat([0]);
  const xMin = 1, xMax = Math.max(2, pts.length);
  let yMin = arrMin(ys), yMax = arrMax(ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.12; yMin -= pad; yMax += pad;
  const sx = x => padL + (x - xMin) / (xMax - xMin) * (W - padL - padR);
  const sy = y => padT + (yMax - y) / (yMax - yMin) * (H - padT - padB);

  const final = pts[pts.length - 1].y;
  const positif = final >= 0;
  const stroke = positif ? "var(--up)" : "var(--down)";
  const gradId = "evo-grad";

  const ligne = pts.map((p, i) => (i ? "L" : "M") + sx(p.x).toFixed(1) + " " + sy(p.y).toFixed(1)).join(" ");
  const baseY = sy(Math.max(yMin, Math.min(0, yMax)));
  const aire = `M${sx(pts[0].x).toFixed(1)} ${baseY.toFixed(1)} ` +
    pts.map(p => "L" + sx(p.x).toFixed(1) + " " + sy(p.y).toFixed(1)).join(" ") +
    ` L${sx(pts[pts.length-1].x).toFixed(1)} ${baseY.toFixed(1)} Z`;

  let yticks = "";
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * i / 4, yy = sy(yv);
    yticks += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-padR}" y2="${yy.toFixed(1)}" stroke="var(--line-soft)" opacity=".7"/>
      <text x="${padL-10}" y="${(yy+4).toFixed(1)}" text-anchor="end" class="chart-tip" fill="var(--ink-faint)">${yv.toFixed(1)}</text>`;
  }
  const zeroLine = (0 >= yMin && 0 <= yMax)
    ? `<line class="zeroline" x1="${padL}" y1="${sy(0).toFixed(1)}" x2="${W-padR}" y2="${sy(0).toFixed(1)}"/>` : "";

  let xticks = ""; const step = Math.max(1, Math.floor(pts.length / 7));
  for (let i = 0; i < pts.length; i += step) {
    xticks += `<text x="${sx(pts[i].x).toFixed(1)}" y="${H-12}" text-anchor="middle" class="chart-tip" fill="var(--ink-faint)">${pts[i].date.slice(5)}</text>`;
  }

  // Sommet et creux : montrent l'amplitude des variations, utile pour juger
  // si une progression est régulière ou faite de coups isolés.
  let maxP = pts[0], minP = pts[0];
  pts.forEach(p => { if (p.y > maxP.y) maxP = p; if (p.y < minP.y) minP = p; });
  const marker = (p, label, color) => `
    <g>
      <circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="7" fill="${color}" opacity=".18"/>
      <circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3.5" fill="${color}"/>
      <text x="${sx(p.x).toFixed(1)}" y="${(sy(p.y)-13).toFixed(1)}" text-anchor="middle" class="chart-badge" fill="${color}">${label}</text>
    </g>`;
  let markers = "";
  if (pts.length > 3 && maxP !== minP) {
    markers += marker(maxP, "MAX", "var(--up)");
    markers += marker(minP, "MIN", "var(--down)");
  }

  // Points individuels colorés selon l'issue du pari
  let dots = "";
  if (pts.length <= 80) {
    dots = pts.map(p => `<circle class="chart-dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.6"
      fill="${p.gagne ? 'var(--up)' : 'var(--down)'}"/>`).join("");
  }

  wrap.innerHTML = `
    <div class="chart-holder">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Évolution du gain cumulé du modèle">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${positif ? '#34d399' : '#fb7185'}" stop-opacity=".26"/>
            <stop offset="100%" stop-color="${positif ? '#34d399' : '#fb7185'}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${yticks}${zeroLine}
        <path d="${aire}" fill="url(#${gradId})"/>
        <path class="curve" d="${ligne}" stroke="${stroke}"/>
        ${dots}${markers}
        <line class="chart-cursor" x1="0" y1="${padT}" x2="0" y2="${H-padB}" opacity="0"/>
        <circle class="chart-cursor-dot" r="4.5" opacity="0"/>
        ${xticks}
        <circle cx="${sx(pts[pts.length-1].x).toFixed(1)}" cy="${sy(final).toFixed(1)}" r="4" fill="${stroke}"/>
        <text x="${(sx(pts[pts.length-1].x)-8).toFixed(1)}" y="${(sy(final)-12).toFixed(1)}" text-anchor="end" class="chart-tip">${final >= 0 ? "+" : ""}${final.toFixed(2)} u.</text>
        <rect class="chart-hit" x="${padL}" y="${padT}" width="${W-padL-padR}" height="${H-padT-padB}" fill="transparent"/>
      </svg>
      <div class="chart-tooltip" hidden></div>
    </div>
    <p class="muted" style="margin-top:.5rem;font-size:.8rem">
      Unité = une mise. ${pts.length} pari(s) affiché(s)${pts.length !== BT_ROWS.length ? " selon les filtres ci-dessus" : ""}.
      Points verts = paris gagnés, rouges = perdus.
    </p>`;

  // --- Infobulle au survol ---
  const holder = wrap.querySelector(".chart-holder");
  const svg = holder.querySelector("svg");
  const cursor = holder.querySelector(".chart-cursor");
  const cursorDot = holder.querySelector(".chart-cursor-dot");
  const tip = holder.querySelector(".chart-tooltip");

  function hide() {
    cursor.setAttribute("opacity", "0");
    cursorDot.setAttribute("opacity", "0");
    tip.hidden = true;
  }

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const relX = (clientX - rect.left) / rect.width * W;
    if (relX < padL - 4 || relX > W - padR + 4) { hide(); return; }

    let best = pts[0], bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(sx(p.x) - relX);
      if (d < bestD) { bestD = d; best = p; }
    }
    const px = sx(best.x), py = sy(best.y);

    cursor.setAttribute("x1", px.toFixed(1));
    cursor.setAttribute("x2", px.toFixed(1));
    cursor.setAttribute("opacity", "1");
    cursorDot.setAttribute("cx", px.toFixed(1));
    cursorDot.setAttribute("cy", py.toFixed(1));
    cursorDot.setAttribute("fill", best.gagne ? "var(--up)" : "var(--down)");
    cursorDot.setAttribute("opacity", "1");

    const gain = best.profit * btStakeFor(best);
    tip.innerHTML = `
      <div class="tt-date">${best.date}</div>
      <div class="tt-match">${best.match}</div>
      <div class="tt-row"><span>${best.pari} · cote ${best.cote.toFixed(2)}</span>
        ${best.gagne ? '<span class="tt-win">Gagné</span>' : '<span class="tt-lose">Perdu</span>'}</div>
      <div class="tt-row"><span class="muted">Score réel</span><span>${best.score}</span></div>
      <div class="tt-cum">Ce pari <strong class="${gain>=0?'pos':'neg'}">${fmtEur(gain)}</strong>
        · cumul <strong class="${best.y>=0?'pos':'neg'}">${best.y >= 0 ? "+" : ""}${best.y.toFixed(2)} u.</strong></div>`;
    tip.hidden = false;

    const pxReal = px / W * rect.width;
    const pyReal = py / H * rect.height;
    const tw = tip.offsetWidth || 200;
    let left = pxReal + 14;
    if (left + tw > rect.width) left = pxReal - tw - 14;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = Math.max(4, Math.min(pyReal - 10, rect.height - (tip.offsetHeight||100) - 4)) + "px";
  }

  const hit = holder.querySelector(".chart-hit");
  hit.addEventListener("mousemove", onMove);
  hit.addEventListener("mouseleave", hide);
  hit.addEventListener("touchstart", onMove, {passive:true});
  hit.addEventListener("touchmove", onMove, {passive:true});
  hit.addEventListener("touchend", hide);
}

// Tous les filtres de la page rejouent le rendu complet : la déduplication
// change les agrégats, donc KPI et graphiques doivent suivre, pas seulement
// le tableau.
["btFilter","btDedup","btDevig","btEnrichi","btLoi","btAlpha","btMvt","btPred","btEvPos","btEvMax","btFiltreQueue","btEdgeDevigMax","btCalib","btEdge","btCoteRange","btGarantie","btMise","btDateDebut","btDateFin"].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener("change", () => renderBacktest());
});

// La mise change les montants affichés partout : on rejoue tout le rendu.
(function initBtStake() {
  const el = $("btStake");
  if (!el) return;
  const maj = () => renderBacktest();
  el.addEventListener("input", maj);
  el.addEventListener("change", maj);
})();

/* ================= PAGE — MARGES DU BOOKMAKER ================= */
const MARGE = WIZARD_DATA.margin_data || {};

function niveauMarge(m) {
  // Seuils fondés sur ce qu'un modèle peut réalistement rattraper.
  if (m < 10) return ["abordable", "lvl-ok"];
  if (m < 20) return ["difficile", "lvl-warn"];
  if (m < 30) return ["très difficile", "lvl-bad"];
  return ["imbattable", "lvl-bad"];
}

function renderMarges() {
  const marches = MARGE.par_marche || [];
  const wrap = $("margeMarcheList");
  if (!wrap) return;

  if (!marches.length) {
    wrap.innerHTML = '<p class="muted">Pas encore de cotes analysables.</p>';
  } else {
    // Échelle ABSOLUE (0 à 40 %) plutôt que relative au maximum observé :
    // une barre doit signifier la même chose d'un run à l'autre, sinon le
    // marché le plus cher paraît toujours "plein" même s'il est raisonnable.
    const ECHELLE_MAX = 40;
    wrap.innerHTML = marches.map(m => {
      const [label, cls] = niveauMarge(m.marge);
      const pct = Math.max(3, Math.min(100, (m.marge / ECHELLE_MAX) * 100));
      return `
        <div class="marge-row">
          <div class="marge-head">
            <span class="marge-nom">${m.marche}</span>
            <span class="marge-val ${cls}">${m.marge.toFixed(1)} %</span>
          </div>
          <div class="marge-bar"><span class="${cls}" style="width:${pct.toFixed(0)}%"></span></div>
          <div class="marge-meta">${m.n} marché(s) · ${m.n_issues} issues · <strong>${label}</strong></div>
        </div>`;
    }).join("");

    const best = marches[0];
    const note = $("margeMarcheNote");
    if (note) {
      let txt = `Le marché le plus abordable est <strong>${best.marche}</strong> (${best.marge.toFixed(1)} %).`;
      if (MARGE.ecart_marches != null && MARGE.ecart_marches > 15) {
        txt += ` L'écart avec le plus cher atteint ${MARGE.ecart_marches} points : le choix du marché ` +
               `est de loin la décision qui pèse le plus sur vos chances.`;
      }
      note.innerHTML = txt;
    }
  }

  renderMargeLigues();

  // Verdict global : marché vs ligue, qu'est-ce qui compte le plus ?
  const vb = $("margeVerdict");
  if (vb && MARGE.ecart_marches != null && MARGE.ecart_ligues != null) {
    const rapport = MARGE.ecart_ligues > 0 ? (MARGE.ecart_marches / MARGE.ecart_ligues) : null;
    let txt = `<strong>Ce qui compte le plus.</strong> L'écart de marge entre marchés est de ` +
      `${MARGE.ecart_marches} points, contre ${MARGE.ecart_ligues} points entre ligues`;
    if (rapport && rapport > 2) {
      txt += ` — soit environ ${rapport.toFixed(0)} fois plus. Choisir le bon <em>marché</em> ` +
             `pèse donc beaucoup plus lourd que choisir la bonne <em>ligue</em>.`;
    } else {
      txt += `. Les deux leviers sont d'importance comparable.`;
    }
    vb.innerHTML = txt;
    vb.style.display = "";
  }
}

function renderMargeLigues() {
  const ligues = MARGE.par_ligue || [];
  const body = $("margeLigueBody");
  if (!body) return;

  if (!ligues.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">Pas encore assez de matchs par ligue ` +
      `(minimum ${MARGE.min_matchs_ligue ?? 8}). Ce classement se remplira au fil de la collecte.</td></tr>`;
    $("margeLigueInfo").textContent = "";
    return;
  }

  const q = ($("margeSearch").value || "").trim().toLowerCase();
  const limit = parseInt($("margeLimit").value);
  let rows = ligues.filter(l =>
    !q || l.ligue.toLowerCase().includes(q) || (l.pays || "").toLowerCase().includes(q));
  const total = rows.length;
  if (limit > 0) rows = rows.slice(0, limit);

  body.innerHTML = rows.map((l, i) => {
    const [label, cls] = niveauMarge(l.marge);
    return `<tr>
      <td data-label="#" class="num muted">${i + 1}</td>
      <td data-label="Ligue"><strong>${ligueLabel(l.pays, l.ligue)}</strong></td>
      <td data-label="Marge" class="num ${cls}"><strong>${l.marge.toFixed(1)} %</strong></td>
      <td data-label="Matchs" class="num muted">${l.n}</td>
      <td data-label="Niveau"><span class="marge-tag ${cls}">${label}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">Aucune ligue ne correspond.</td></tr>`;

  let info = `${rows.length} ligue(s) affichée(s) sur ${total}`;
  if (MARGE.mediane_ligues != null) info += ` · médiane ${MARGE.mediane_ligues.toFixed(1)} %`;
  // Avertissement sur la fiabilité quand les échantillons sont petits
  const petits = ligues.filter(l => l.n < 20).length;
  if (petits > ligues.length / 2) {
    info += " · ⚠ échantillons encore réduits, ce classement peut bouger";
  }
  $("margeLigueInfo").textContent = info;
}

["margeSearch", "margeLimit"].forEach(id => {
  const el = $(id);
  if (el) { el.addEventListener("input", renderMargeLigues); el.addEventListener("change", renderMargeLigues); }
});

/* ================= PAGE — BANKROLL ================= */
// Construit un index (date|match|pari) -> ligne du backtest, pour retrouver
// le résultat RÉEL d'un pari coché "joué" une fois son match terminé. Un
// pari joué qui n'apparaît dans AUCUNE ligne du backtest (match pas encore
// joué, ou edge sous le seuil retenu par le modèle ce jour-là) reste "en
// attente" plutôt que de fausser le calcul avec une estimation.
function renderBankroll() {
  const departEl = $("bkDepart");
  const evoWrap = $("bkEvoWrap"), body = $("bkBody");
  if (!departEl || !evoWrap || !body) return;
  const depart = parseFloat(departEl.value) || 0;

  const backtestParCle = {};
  BT_ROWS.forEach(r => { backtestParCle[`${r.date}|${r.match}|${r.colonne}`] = r; });

  const paris = [...PLACED.entries()].map(([cle, info]) => {
    const [date, match, pari] = cle.split("|");
    const bt = backtestParCle[cle];
    return {
      cle, date, match, pari, mise: info.mise || 0,
      cote: bt ? bt.cote : null, resolu: !!bt,
      gagne: bt ? bt.gagne : null, profitUnites: bt ? bt.profit : null,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.cle.localeCompare(b.cle));

  let bankroll = depart, net = 0, resolus = 0, attente = 0;
  const pts = [{date: "Départ", y: depart}];
  const lignes = paris.map(p => {
    let resultatEuros = null, statut = "En attente", bankrollApres = null;
    if (p.resolu) {
      resultatEuros = p.profitUnites * p.mise;
      bankroll += resultatEuros;
      net += resultatEuros;
      resolus++;
      statut = p.gagne ? "Gagné" : "Perdu";
      bankrollApres = bankroll;
      pts.push({date: p.date, y: bankroll, match: p.match, pari: p.pari,
               mise: p.mise, statut, resultatEuros, gagne: p.gagne});
    } else {
      attente++;
    }
    return {...p, resultatEuros, statut, bankrollApres};
  });

  $("bkActuelle").textContent = bankroll.toLocaleString("fr-FR", {maximumFractionDigits: 2}) + " €";
  const netEl = $("bkNet");
  netEl.textContent = fmtEur(net);
  netEl.className = "v " + (net >= 0 ? "pos" : "neg");
  $("bkResolus").textContent = resolus;
  $("bkAttente").textContent = attente;

  drawBankrollChart(pts, "bkEvoWrap");

  body.innerHTML = lignes.map(l => `
    <tr>
      <td data-label="Date">${l.date}</td>
      <td data-label="Match">${l.match}</td>
      <td data-label="Pari">${l.pari}</td>
      <td data-label="Cote" class="num">${l.cote != null ? l.cote.toFixed(2) : "—"}</td>
      <td data-label="Mise" class="num">${l.mise.toFixed(2)} €</td>
      <td data-label="Statut">${l.statut}</td>
      <td data-label="Résultat" class="num ${l.resultatEuros == null ? "" : (l.resultatEuros >= 0 ? "pos" : "neg")}">${l.resultatEuros != null ? fmtEur(l.resultatEuros) : "—"}</td>
      <td data-label="Bankroll" class="num">${l.bankrollApres != null ? l.bankrollApres.toLocaleString("fr-FR",{maximumFractionDigits:2}) + " €" : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">Aucun pari marqué comme joué pour l'instant — cochez "Marquer comme joué" sur la page Paris à venir.</td></tr>`;
}

// Graphique en escalier : un point par pari RÉSOLU (pas par jour), la
// bankroll ne bougeant qu'une fois un résultat connu — même mécanique SVG
// que drawEvolution (page DC rétrospectif), simplifiée (pas de survol
// détaillé point par point, l'échelle de temps étant ici irrégulière).
function drawBankrollChart(pts, wrapId) {
  const wrap = $(wrapId);
  if (!wrap) return;
  if (pts.length < 2) {
    wrap.innerHTML = '<p class="muted">Pas encore assez de paris résolus pour tracer une évolution.</p>';
    return;
  }
  const W = 1180, H = 260, padL = 66, padR = 22, padT = 26, padB = 38;
  const ys = pts.map(p => p.y);
  const xMax = pts.length - 1;
  let yMin = arrMin(ys), yMax = arrMax(ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.12; yMin -= pad; yMax += pad;
  const sx = i => padL + i / (xMax || 1) * (W - padL - padR);
  const sy = y => padT + (yMax - y) / (yMax - yMin) * (H - padT - padB);

  const positif = pts[pts.length - 1].y >= pts[0].y;
  const stroke = positif ? "var(--up)" : "var(--down)";

  const ligne = pts.map((p, i) => (i ? "L" : "M") + sx(i).toFixed(1) + " " + sy(p.y).toFixed(1)).join(" ");
  const baseY = sy(Math.max(yMin, Math.min(pts[0].y, yMax)));
  const aire = `M${sx(0).toFixed(1)} ${baseY.toFixed(1)} ` +
    pts.map((p, i) => "L" + sx(i).toFixed(1) + " " + sy(p.y).toFixed(1)).join(" ") +
    ` L${sx(pts.length - 1).toFixed(1)} ${baseY.toFixed(1)} Z`;

  let yticks = "";
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * i / 4, yy = sy(yv);
    yticks += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W-padR}" y2="${yy.toFixed(1)}" stroke="var(--line-soft)" opacity=".7"/>
      <text x="${padL-10}" y="${(yy+4).toFixed(1)}" text-anchor="end" class="chart-tip" fill="var(--ink-faint)">${yv.toFixed(0)}€</text>`;
  }
  let xticks = ""; const step = Math.max(1, Math.floor(pts.length / 7));
  for (let i = 0; i < pts.length; i += step) {
    xticks += `<text x="${sx(i).toFixed(1)}" y="${H-12}" text-anchor="middle" class="chart-tip" fill="var(--ink-faint)">${pts[i].date === "Départ" ? "Départ" : pts[i].date.slice(5)}</text>`;
  }

  wrap.innerHTML = `
    <div class="chart-holder">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Évolution de la bankroll">
        <defs>
          <linearGradient id="grad-${wrapId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${positif ? '#34d399' : '#fb7185'}" stop-opacity=".26"/>
            <stop offset="100%" stop-color="${positif ? '#34d399' : '#fb7185'}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${yticks}
        <path d="${aire}" fill="url(#grad-${wrapId})"/>
        <path d="${ligne}" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
        <line class="chart-cursor" x1="0" y1="${padT}" x2="0" y2="${H-padB}" opacity="0"/>
        <circle class="chart-cursor-dot" r="4.5" opacity="0"/>
        ${xticks}
        <rect class="chart-hit" x="${padL}" y="${padT}" width="${W-padL-padR}" height="${H-padT-padB}" fill="transparent"/>
      </svg>
      <div class="chart-tooltip" hidden></div>
    </div>`;

  // --- Infobulle au survol : même mécanisme que drawEvolution (page DC
  // rétrospectif), adapté à deux natures de points possibles — un pari
  // individuel résolu (bankroll réelle) ou un jour agrégé (simulation),
  // distingués par la présence de "match" ou de "n" sur le point. ---
  const holder = wrap.querySelector(".chart-holder");
  const svg = holder.querySelector("svg");
  const cursor = holder.querySelector(".chart-cursor");
  const cursorDot = holder.querySelector(".chart-cursor-dot");
  const tip = holder.querySelector(".chart-tooltip");

  function hide() {
    cursor.setAttribute("opacity", "0");
    cursorDot.setAttribute("opacity", "0");
    tip.hidden = true;
  }

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const relX = (clientX - rect.left) / rect.width * W;
    if (relX < padL - 4 || relX > W - padR + 4) { hide(); return; }

    let bestI = 0, bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(sx(i) - relX);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    const best = pts[bestI];
    const px = sx(bestI), py = sy(best.y);

    cursor.setAttribute("x1", px.toFixed(1));
    cursor.setAttribute("x2", px.toFixed(1));
    cursor.setAttribute("opacity", "1");
    cursorDot.setAttribute("cx", px.toFixed(1));
    cursorDot.setAttribute("cy", py.toFixed(1));
    cursorDot.setAttribute("fill", stroke);
    cursorDot.setAttribute("opacity", "1");

    let corps;
    if (best.date === "Départ") {
      corps = `<div class="tt-row"><span class="muted">Bankroll de départ</span></div>`;
    } else if (best.match) {
      // Point = un pari réel résolu
      corps = `
        <div class="tt-match">${best.match}</div>
        <div class="tt-row"><span>${best.pari} · mise ${best.mise.toFixed(2)} €</span>
          ${best.gagne ? '<span class="tt-win">Gagné</span>' : '<span class="tt-lose">Perdu</span>'}</div>
        <div class="tt-row"><span class="muted">Résultat</span>
          <strong class="${best.resultatEuros>=0?'pos':'neg'}">${fmtEur(best.resultatEuros)}</strong></div>`;
    } else if (best.n != null) {
      // Point = un jour agrégé de la simulation
      corps = `
        <div class="tt-row"><span>${best.n} pari(s) ce jour</span></div>
        <div class="tt-row"><span class="muted">Exposition</span><span>${best.exposition.toLocaleString("fr-FR",{maximumFractionDigits:2})} €</span></div>
        <div class="tt-row"><span class="muted">Résultat du jour</span>
          <strong class="${best.resultatJour>=0?'pos':'neg'}">${fmtEur(best.resultatJour)}</strong></div>`;
    } else {
      corps = "";
    }

    tip.innerHTML = `
      <div class="tt-date">${best.date}</div>
      ${corps}
      <div class="tt-cum">Bankroll <strong class="${best.y>=0?'pos':'neg'}">${best.y.toLocaleString("fr-FR",{maximumFractionDigits:2})} €</strong></div>`;
    tip.hidden = false;

    const pxReal = px / W * rect.width;
    const pyReal = py / H * rect.height;
    const tw = tip.offsetWidth || 200;
    let left = pxReal + 14;
    if (left + tw > rect.width) left = pxReal - tw - 14;
    tip.style.left = Math.max(4, left) + "px";
    tip.style.top = Math.max(4, Math.min(pyReal - 10, rect.height - (tip.offsetHeight||100) - 4)) + "px";
  }

  const hit = holder.querySelector(".chart-hit");
  hit.addEventListener("mousemove", onMove);
  hit.addEventListener("mouseleave", hide);
  hit.addEventListener("touchstart", onMove, {passive:true});
  hit.addEventListener("touchmove", onMove, {passive:true});
  hit.addEventListener("touchend", hide);
}
if ($("bkDepart")) {
  $("bkDepart").addEventListener("input", renderBankroll);
  $("bkDepart").addEventListener("change", renderBankroll);
}

// --- Simulation d'exposition sur l'historique du backtest --------------
// Contrairement à renderBankroll() ci-dessus (vos VRAIS paris joués),
// cette section est une simulation : elle applique une stratégie de mise
// à TOUT ce que le backtest a retenu, avec les MÊMES filtres que la page
// DC rétrospectif (btFiltered — les deux pages partagent déjà ces
// réglages, cf. lierFiltres plus haut). Sert à choisir une stratégie AVANT
// de l'appliquer pour de vrai, pas à prédire l'avenir.
function renderExposition() {
  const wrap = $("simEvoWrap"), body = $("simBody");
  if (!wrap || !body) return;

  const strategie = $("simStrategie") ? $("simStrategie").value : "fixe";
  const montantFixe = parseFloat($("simMontantFixe").value) || 0;
  const pctMax = (parseFloat($("simPct").value) || 0) / 100;
  const fracKelly = parseFloat($("simKellyFrac") ? $("simKellyFrac").value : "0.25") || 0.25;
  const depart = parseFloat($("bkDepart") ? $("bkDepart").value : 100) || 0;

  const rows = btFiltered().slice().sort((a, b) => a.date.localeCompare(b.date));
  const parJour = {};
  rows.forEach(r => { (parJour[r.date] = parJour[r.date] || []).push(r); });
  const dates = Object.keys(parJour).sort();

  // Contrairement au backtest de la page « DC rétrospectif » (bankroll de
  // référence figée pour rester indépendant de l'ordre des paris), la
  // bankroll ICI compose vraiment jour après jour : c'est le but même de
  // cette simulation — rendre visible ce que Kelly change réellement, ce
  // qu'une bankroll figée ne peut pas montrer.
  let bankroll = depart, pic = 0, picJour = null;
  const pts = [{date: "Départ", y: depart}];
  const lignes = dates.map(date => {
    const paris = parJour[date];
    const n = paris.length;
    let misesParPari;
    if (strategie === "kelly") {
      // Mise Kelly : propre à CHAQUE pari (edge et cote lui sont propres),
      // calculée sur la bankroll telle qu'elle est au début de ce jour —
      // pas répartie également comme le mode "%".
      const brutes = paris.map(r => kellyFraction(r.p_aff ?? r.p_model, r.cote, fracKelly) * bankroll);
      const totalBrut = brutes.reduce((s, m) => s + m, 0);
      // kellyFraction plafonne déjà CHAQUE pari à 10 % de la bankroll
      // (MISE_PLAFOND), mais plusieurs paris à fort edge le même jour
      // peuvent quand même réclamer, ensemble, plus que la bankroll totale
      // (jusqu'à 23 paris qualifiés le même jour sur l'historique récent,
      // cf. l'avertissement plus haut sur cette page). On ne peut pas
      // engager plus que ce qu'on a : les mises du jour sont réduites au
      // prorata si leur somme dépasse la bankroll disponible.
      const echelle = (totalBrut > bankroll && totalBrut > 0) ? bankroll / totalBrut : 1;
      misesParPari = brutes.map(m => m * echelle);
    } else if (strategie === "pct") {
      // % de la bankroll par jour, réparti également : l'exposition du
      // jour est PLAFONNÉE d'avance — elle ne dépend plus du hasard du
      // nombre de matchs qualifiés.
      const m = (bankroll * pctMax) / n;
      misesParPari = paris.map(() => m);
    } else {
      // Mise fixe : chaque pari coûte le même montant, l'exposition du
      // jour grandit avec le nombre de paris qualifiés ce jour-là (c'est
      // justement ce qui a atteint 115€ un jour sur 5€/pari dans l'exemple
      // qui a motivé cette page).
      misesParPari = paris.map(() => montantFixe);
    }
    const exposition = misesParPari.reduce((s, m) => s + m, 0);
    const resultatJour = paris.reduce((s, r, i) => s + r.profit * misesParPari[i], 0);
    bankroll += resultatJour;
    if (exposition > pic) { pic = exposition; picJour = date; }
    pts.push({date, y: bankroll, n, exposition, resultatJour});
    return {date, n, exposition, resultatJour, bankrollApres: bankroll};
  });

  $("simFinale").textContent = bankroll.toLocaleString("fr-FR", {maximumFractionDigits: 2}) + " €";
  $("simPic").textContent = pic.toLocaleString("fr-FR", {maximumFractionDigits: 2}) + " €";
  $("simPicJour").textContent = picJour || "—";
  $("simJours").textContent = dates.length;

  drawBankrollChart(pts, "simEvoWrap");

  body.innerHTML = lignes.map(l => `
    <tr>
      <td data-label="Date">${l.date}</td>
      <td data-label="Nb paris" class="num">${l.n}</td>
      <td data-label="Exposition" class="num">${l.exposition.toLocaleString("fr-FR",{maximumFractionDigits:2})} €</td>
      <td data-label="Résultat du jour" class="num ${l.resultatJour >= 0 ? "pos" : "neg"}">${fmtEur(l.resultatJour)}</td>
      <td data-label="Bankroll après" class="num">${l.bankrollApres.toLocaleString("fr-FR",{maximumFractionDigits:2})} €</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Aucun pari ne correspond aux filtres actuels de la page DC rétrospectif.</td></tr>`;
}

if ($("simStrategie")) {
  $("simStrategie").addEventListener("change", () => {
    const val = $("simStrategie").value;
    $("simFixeWrap").style.display = val === "fixe" ? "" : "none";
    $("simPctWrap").style.display = val === "pct" ? "" : "none";
    $("simKellyWrap").style.display = val === "kelly" ? "" : "none";
    if ($("simKellyNote")) $("simKellyNote").style.display = val === "kelly" ? "" : "none";
    renderExposition();
  });
  ["simMontantFixe", "simPct", "simKellyFrac"].forEach(id => {
    $(id).addEventListener("input", renderExposition);
    $(id).addEventListener("change", renderExposition);
  });
  // bkDepart sert de base aux DEUX simulations (réelle et hypothétique) :
  // un changement doit redessiner les deux plutôt que seulement la première.
  $("bkDepart").addEventListener("input", renderExposition);
  $("bkDepart").addEventListener("change", renderExposition);
}

/* ---------- Init ---------- */
refresh();
renderValueBets();
renderUpcoming();
renderBankroll();
// Sans cet appel, le panneau "Simulation sur l'historique" restait vide
// (tirets) tant qu'on n'avait pas soi-meme touche un de ses reglages —
// il ne se rendait qu'au premier "change", jamais au chargement.
if (typeof renderExposition === "function") renderExposition();
renderTeams();
renderOverview();
/* ================= PAGE — TIRS CADRÉS (récap) ================= */

let tiSortKey = "n", tiSortDir = -1;

function tirsCell(val, isDefense) {
  if (val == null) return '<td class="num muted">—</td>';
  const good = isDefense ? val < 1 : val > 1;
  const cls = good ? "pos" : (val === 1 ? "" : "neg");
  return `<td class="num ${cls}">${val.toFixed(2)}</td>`;
}

function renderTirsPage() {
  const c = WIZARD_DATA.shots_coverage || {};
  const board = $("tirsScoreboard");
  const repartWrap = $("tirsRepartWrap");
  if (!board || !repartWrap) return;

  if (!c.n_matchs) {
    board.innerHTML = '<p class="muted">Aucune donnée de tirs cadrés collectée pour l\'instant — '
      + 'lancez api_football_collect.py, puis relancez wina_wizard.py.</p>';
    repartWrap.innerHTML = "";
    $("tirsBody").innerHTML = '<tr><td colspan="5" class="muted">En attente de données.</td></tr>';
    $("tirsCount").textContent = "";
    return;
  }

  const seuil = c.seuil || 6;
  const periode = c.periode ? `du ${c.periode[0]} au ${c.periode[1]}` : "période inconnue";
  const pret = c.equipes_pretes || 0;
  const pct = c.n_equipes ? (pret / c.n_equipes * 100) : 0;

  board.innerHTML = `
    <div class="scoreboard">
      <div class="score-tile">
        <div class="st-label">Matchs avec tirs cadrés</div>
        <div class="st-value">${c.n_matchs}</div>
        <div class="st-sub">${periode}</div>
      </div>
      <div class="score-tile">
        <div class="st-label">Équipes couvertes</div>
        <div class="st-value">${c.n_equipes}</div>
        <div class="st-sub">${c.moyenne_ligue != null ? c.moyenne_ligue + " tirs cadrés / équipe / match" : "—"}</div>
      </div>
      <div class="score-tile">
        <div class="st-label">Équipes exploitables</div>
        <div class="st-value ${pret ? 'pos' : 'neg'}">${pret}</div>
        <div class="st-sub">au moins ${seuil} rencontres (${pct.toFixed(0)} %)</div>
      </div>
    </div>`;

  // Répartition : combien d'équipes à 1, 2, 3... rencontres.
  const rep = c.repartition || {};
  const ordre = ["1", "2", "3", "4", "5", "6+"];
  const maxEq = Math.max(1, ...ordre.map(k => rep[k] || 0));
  repartWrap.innerHTML = `<div class="cote-rows">` + ordre.filter(k => rep[k]).map(k => {
    const n = rep[k];
    const okSeuil = k === "6+";
    return `
      <div class="cote-row">
        <div class="cote-label">${k} match${k === "1" ? "" : "s"}</div>
        <div class="cote-track">
          <div class="cote-axis" style="left:0"></div>
          <div class="cote-fill ${okSeuil ? 'pos' : 'neg'}"
               style="left:0; width:${(n / maxEq * 92).toFixed(1)}%"></div>
        </div>
        <div class="cote-val ${okSeuil ? 'pos' : ''}">${n}</div>
        <div class="cote-meta"><span class="muted">équipe${n > 1 ? "s" : ""}${okSeuil ? " — exploitables" : ""}</span></div>
      </div>`;
  }).join("") + `</div>`;

  renderTirsTable();
}

function renderTirsTable() {
  const c = WIZARD_DATA.shots_coverage || {};
  const equipes = c.equipes || [];
  const ligue = $("tiLigue").value;
  const search = $("tiSearch").value.trim().toLowerCase();
  const minM = parseInt($("tiMinMatches").value) || 0;

  // ligueKey(pays, ligue) plutôt que le seul nom de ligue : "Serie A",
  // "Primera División" ou "Super League" existent dans plusieurs pays sans
  // aucun rapport entre eux (voir _index_pays_equipes côté Python) — filtrer
  // sur le nom seul mélangerait ces championnats homonymes.
  let rows = equipes.filter(e =>
    (!ligue || ligueKey(e.pays, e.ligue) === ligue) &&
    (!search || e.equipe.toLowerCase().includes(search)) &&
    e.n >= minM
  );
  rows.sort((a, b) => {
    let va = a[tiSortKey], vb = b[tiSortKey];
    if (va == null) va = -Infinity; if (vb == null) vb = -Infinity;
    if (typeof va === "string") return tiSortDir * va.localeCompare(vb);
    return tiSortDir * (va - vb);
  });

  $("tirsBody").innerHTML = rows.slice(0, 500).map(e => `
    <tr>
      <td><strong>${e.equipe}</strong></td>
      <td><span class="pill">${ligueLabel(e.pays, e.ligue) || e.ligue || "—"}</span></td>
      ${tirsCell(e.attaque, false)}
      ${tirsCell(e.defense, true)}
      <td class="num muted">${e.n}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Aucune équipe ne correspond à ces filtres.</td></tr>`;
  $("tirsRowInfo").textContent = `${rows.length} équipe(s)` + (rows.length > 500 ? " (500 affichées)" : "");
  $("tirsCount").textContent = `— ${equipes.length} équipe(s) au total`;
}

(function initTirsFilters() {
  const c = WIZARD_DATA.shots_coverage || {};
  // Une entrée par (pays, ligue) — pas par seul nom de ligue — pour ne pas
  // fusionner deux championnats homonymes de pays différents dans le menu.
  const parKey = new Map();
  (c.equipes || []).forEach(e => {
    if (!e.ligue) return;
    const k = ligueKey(e.pays, e.ligue);
    if (!parKey.has(k)) parKey.set(k, e);
  });
  const options = [...parKey.values()].sort((a, b) =>
    ligueLabel(a.pays, a.ligue).localeCompare(ligueLabel(b.pays, b.ligue)));
  const sel = $("tiLigue");
  options.forEach(e => {
    const o = document.createElement("option");
    o.value = ligueKey(e.pays, e.ligue); o.textContent = ligueLabel(e.pays, e.ligue);
    sel.appendChild(o);
  });
})();
["tiLigue", "tiSearch", "tiMinMatches"].forEach(id => {
  const el = $(id);
  el.addEventListener("input", renderTirsTable);
  el.addEventListener("change", renderTirsTable);
});
document.querySelectorAll("#tirsTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.tik;
    if (tiSortKey === k) tiSortDir *= -1; else { tiSortKey = k; tiSortDir = (k === "equipe" || k === "ligue") ? 1 : -1; }
    renderTirsTable();
  });
});

renderBacktest();
drawShotsCoverage();
renderTirsPage();
renderMarges();
