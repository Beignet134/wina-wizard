// WIZARD_DATA est défini dans donnees.js (généré par wina_wizard.py à chaque run),
// chargé AVANT ce fichier dans index.html.
const BETS = WIZARD_DATA.bets;
const UNMATCHED = WIZARD_DATA.unmatched_examples;
const VALUE_BETS = WIZARD_DATA.value_bets;
const MIN_BETS = WIZARD_DATA.config.min_bets_for_verdict;
const OOS_MIN = WIZARD_DATA.config.oos_min_test;
const UPCOMING_DAYS = WIZARD_DATA.config.upcoming_days;
const MIN_EDGE = WIZARD_DATA.config.min_edge ?? 0.02;

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

  // Options de ligue du filtre (autrefois générées côté Python)
  const ligues = [...new Set(BETS.map(b => b.ligue).filter(Boolean))].sort();
  const sel = $("fLigue");
  ligues.forEach(l => { const o=document.createElement("option"); o.value=l; o.textContent=l; sel.appendChild(o); });

  // Idem pour le filtre Ligue de la page DC rétrospectif, à partir des
  // paris du backtest (dc_backtest), qui ont leur propre champ "ligue".
  // Même liste pour "Paris à venir" (uLigue) : l'UNION des ligues du
  // backtest ET des value bets à venir, pas seulement ces dernières —
  // sinon les deux filtres n'auraient pas les mêmes options et la liaison
  // entre les deux pages (plus bas) échouerait silencieusement dès qu'une
  // valeur de l'un est absente de la liste de l'autre.
  const btSel = $("btLigue"), uSelLigue = $("uLigue");
  if (btSel || uSelLigue) {
    const toutesLigues = [...new Set([
      ...(WIZARD_DATA.dc_backtest || []).map(r => r.ligue),
      ...(WIZARD_DATA.value_bets || []).map(r => r.ligue),
    ].filter(Boolean))].sort();
    toutesLigues.forEach(l => {
      if (btSel) { const o=document.createElement("option"); o.value=l; o.textContent=l; btSel.appendChild(o); }
      if (uSelLigue) { const o=document.createElement("option"); o.value=l; o.textContent=l; uSelLigue.appendChild(o); }
    });
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
  if (f.ligue && b.ligue !== f.ligue) return false;
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
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
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
        <path d="${area}" fill="url(#${gradId})"/>
        <path class="curve" d="${line}" stroke="${stroke}"/>
        ${dots}${markers}
        <line class="chart-cursor" x1="0" y1="${padT}" x2="0" y2="${H-padB}" opacity="0"/>
        <circle class="chart-cursor-dot" r="4.5" opacity="0"/>
        ${xticks}
        <rect class="chart-hit" x="${padL}" y="${padT}" width="${W-padL-padR}" height="${H-padT-padB}" fill="transparent"/>
      </svg>
      <div class="chart-tooltip" hidden></div>
    </div>`;

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
      <td data-label="Date">${b.date}</td><td data-label="Match">${b.match}</td><td data-label="Ligue"><span class="pill">${b.ligue}</span></td>
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
(function initUnmatched() {
  const box = $("unmatchedBox"), list = $("unmatchedList");
  if (!UNMATCHED.length) { box.style.display="none"; return; }
  box.querySelector("summary").textContent = UNMATCHED.length + " exemple(s) de match non rapproché — cliquer pour voir";
  list.innerHTML = UNMATCHED.map(t=>`<li>${t}</li>`).join("");
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
      <td data-label="Date">${v.date}</td><td data-label="Match">${v.match}</td><td data-label="Ligue"><span class="pill">${v.ligue}</span></td>
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
// Nombre de paris du JOUR précisément (pas le total sur toute la fenêtre
// à venir) : cohérent avec un usage "je mise chaque matin pour les matchs
// du jour" — la fenêtre entière reste consultable sur la page elle-même,
// triée par date par défaut.
{
  const aujourdhui = new Date().toISOString().slice(0, 10);
  $("tabUpCount").textContent = UPCOMING.filter(v => v.date === aujourdhui).length;
}

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

function betKey(v) {
  return `${v.date}|${v.match}|${v.colonne}`;
}

function togglePlaced(key, on, mise) {
  if (on) PLACED.set(key, {mise: mise != null ? mise : (PLACED.get(key)?.mise ?? null)});
  else PLACED.delete(key);
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
  const cat = $("uCat").value, edge = parseFloat($("uEdge").value), sortBy = $("uSort").value;
  const ligue = $("uLigue") ? $("uLigue").value : "";
  const pred = $("uPred") ? $("uPred").value : "";
  const devig = $("uDevig") ? $("uDevig").value === "1" : false;
  const alpha = blendAlpha("uAlpha");

  // ENRICHISSEMENT xG — même substitution centralisée que btFiltered() sur
  // la page DC rétrospectif : les champs p_model/edge/edge_devig/ev/
  // lam_home/lam_away de la source portent déjà la bonne valeur pour le
  // mode actif, tout le reste de la fonction continue de les lire sans
  // rien savoir du mode. Les matchs sans historique xG suffisant sont
  // EXCLUS en mode "avec", jamais comblés par la valeur en buts déguisée.
  const enrichi = $("uEnrichi") ? $("uEnrichi").value === "avec" : false;
  // Correction de calibration appliquée à l'ensemble AVANT la substitution
  // xG — même ordre que sur la page DC rétrospectif, pour que les deux
  // pages restent strictement comparables quand leurs filtres sont liés.
  const calibActif = $("uCalib") ? $("uCalib").value === "1" : false;
  let source = calibrer(UPCOMING, calibActif);
  if (enrichi) {
    source = source
      .filter(v => v.p_model_xg != null)
      .map(v => ({
        ...v,
        p_model: v.p_model_xg, edge: v.edge_xg, edge_devig: v.edge_devig_xg,
        ev: v.ev_xg, lam_home: v.lam_home_xg, lam_away: v.lam_away_xg,
        p_model_buts: v.p_model, edge_buts: v.edge, edge_devig_buts: v.edge_devig,
        lam_home_buts: v.lam_home, lam_away_buts: v.lam_away,
      }));
  }

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
    if (cat && v.categorie !== cat) return false;
    if (ligue && v.ligue !== ligue) return false;
    if (v.edge_aff < edge) return false;
    if (!dansPlageCote(v.cote, $("uCote") ? $("uCote").value : "")) return false;
    // Espérance : un edge dévigué positif ne garantit PAS une espérance
    // positive — sur une cote très basse, la marge du bookmaker peut
    // dépasser l'avantage du modèle (ex. cote 1.03 à 91 % : edge +2,5 %
    // mais espérance -6,3 %). ev_aff porte déjà la valeur du mode actif
    // (mélangée si α < 1), donc le filtre suit ce qui est affiché.
    if ($("uEvPos") && $("uEvPos").value === "1") {
      const ev = v.ev_aff ?? v.ev;
      if (ev == null || ev <= 0) return false;
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
      if (mv === "allonge" && v.raccourcit) return false;
      if (mv === "stable" && Math.abs(variation) >= 0.01) return false;
      // Écarte les paris dont la cote s'allonge : mesuré à -53 % de ROI sur
      // les données réelles, contre -5 % pour celles qui raccourcissent.
      if (mv === "sauf_allonge" && variation < -0.0001) return false;
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
  const n = rows.length, mise = n*stake;
  const evTotal = rows.reduce((s,v)=>s+(v.ev_aff ?? v.ev)*stake, 0);
  const matches = new Set(rows.map(v=>v.match)).size;
  $("uNb").textContent = n;
  $("uMise").textContent = mise.toLocaleString("fr-FR") + " €";
  const evEl=$("uEv"); evEl.textContent=fmtEur(evTotal); evEl.className="v "+(evTotal>=0?"pos":"neg");
  $("uMatches").textContent = matches;

  // Même note de transparence que sur DC rétrospectif : en mode enrichi,
  // les matchs sans historique xG suffisant des deux côtés disparaissent
  // de la vue plutôt que d'être remplacés par l'estimation en buts seuls
  // déguisée en xG — le dire explicitement évite de croire à une baisse de
  // recommandations qui ne serait qu'une baisse de couverture xG.
  const uEnrichiNote = $("uEnrichiNote");
  if (uEnrichiNote) {
    if (enrichi) {
      const avecXg = UPCOMING.filter(v => v.p_model_xg != null);
      const nMatchsXg = new Set(avecXg.map(v => v.match + v.date)).size;
      uEnrichiNote.style.display = "";
      uEnrichiNote.innerHTML = `<strong>Mode enrichi actif</strong> — ${n} pari(s) affiché(s) `
        + `après filtres, parmi ${avecXg.length} paris testés sur ${nMatchsXg} match(s) où `
        + `l'historique xG était suffisant des deux côtés (${UPCOMING.length} paris à venir au `
        + `total, modèle en buts seul compris).`;
    } else {
      uEnrichiNote.style.display = "none";
    }
  }

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
      <div class="rec-league">${v.ligue} · <span class="tag-cat">${v.categorie}</span></div>
      <div class="rec-bet">
        <span class="rec-pill">${v.colonne}</span>
        <span class="muted">à la cote</span> <strong style="font-family:var(--mono)">${v.cote.toFixed(2)}</strong>
      </div>
      <div class="rec-metrics">
        <div class="rec-metric"><div class="mk">Proba retenue</div><div class="mv">${((v.p_aff ?? v.p_model)*100).toFixed(0)} %</div></div>
        <div class="rec-metric"><div class="mk">Edge</div><div class="mv pos">${fmtPct(v.edge_aff ?? v.edge)}</div></div>
        <div class="rec-metric"><div class="mk">Espérance</div><div class="mv ${(v.ev_aff ?? v.ev)>=0?'pos':'neg'}">${fmtPct(v.ev_aff ?? v.ev)}</div></div>
      </div>
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
["uStake","uCat","uLigue","uEdge","uSort","uDevig","uAlpha","uMvt","uPred","uEnrichi","uDedup","uEvPos","uCalib","uCote"].forEach(id => {
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
[["btCat","uCat"], ["btLigue","uLigue"], ["btDevig","uDevig"], ["btAlpha","uAlpha"],
 ["btMvt","uMvt"], ["btPred","uPred"], ["btEnrichi","uEnrichi"], ["btDedup","uDedup"],
 ["btEvPos","uEvPos"], ["btCalib","uCalib"], ["btEdge","uEdge"],
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
(function initTeamFilters() {
  const pays = [...new Set(TEAM_STATS.map(t => t.pays).filter(Boolean))].sort();
  const ligues = [...new Set(TEAM_STATS.map(t => t.ligue).filter(Boolean))].sort();
  const annees = [...new Set(TEAM_STATS.flatMap(t => t.annees || []))].sort();
  const fill = (sel, vals) => vals.forEach(v => { const o=document.createElement("option"); o.value=v; o.textContent=v; $(sel).appendChild(o); });
  fill("tPays", pays); fill("tLigue", ligues); fill("tAnnee", annees);
})();

let tSortKey = "atk_home", tSortDir = -1;

// Quand on choisit un pays, restreindre les ligues à ce pays
$("tPays").addEventListener("change", () => {
  const pays = $("tPays").value;
  const ligues = [...new Set(TEAM_STATS.filter(t=>!pays||t.pays===pays).map(t=>t.ligue).filter(Boolean))].sort();
  const sel = $("tLigue"), cur = sel.value;
  sel.innerHTML = '<option value="">Toutes</option>';
  ligues.forEach(l => { const o=document.createElement("option"); o.value=l; o.textContent=l; sel.appendChild(o); });
  if (ligues.includes(cur)) sel.value = cur;
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
    (!ligue || t.ligue === ligue) &&
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
      <td><span class="pill">${t.ligue}</span></td>
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
function renderOverview() {
  const stake = 10; // mise de référence pour la vue d'ensemble (indépendante des filtres des autres onglets)
  const n = BETS.length, mise = n * stake;
  let net = 0, wins = 0;
  BETS.forEach(b => { net += betGain(b, stake); if (b.won) wins++; });
  const roi = mise > 0 ? net / mise : null;

  const netEl = $("ovNet");
  netEl.textContent = fmtEur(net);
  netEl.className = "st-value " + (net >= 0 ? "pos" : "neg");
  $("ovNetSub").textContent = `${n} pari(s) évalué(s)`;
  const bar = $("ovNetBar");
  bar.style.width = Math.min(100, Math.abs(roi || 0) * 150).toFixed(0) + "%";
  bar.style.background = net >= 0 ? "var(--pitch)" : "var(--card-red)";

  const roiEl = $("ovRoi");
  roiEl.textContent = fmtPct(roi);
  roiEl.className = "st-value " + (roi >= 0 ? "pos" : "neg");
  $("ovRoiSub").textContent = n > 0 ? `sur ${n} paris` : "aucune donnée";

  $("ovWin").textContent = n > 0 ? (wins / n * 100).toFixed(1) + " %" : "—";
  $("ovWinSub").textContent = n > 0 ? `${wins} / ${n} gagnés` : "tous paris confondus";

  $("ovUpcoming").textContent = UPCOMING.length;
  $("ovUpcomingSub").textContent = `sur ${UPCOMING_DAYS} jours · modèle Dixon-Coles`;

  drawChart(BETS, stake, "ovChartWrap", 300);

  const cats = {};
  BETS.forEach(b => { (cats[b.cat] = cats[b.cat] || []).push(b); });
  const catRows = Object.keys(cats).map(cat => {
    const arr = cats[cat], cn = arr.length;
    const cnet = arr.reduce((s, b) => s + betGain(b, stake), 0);
    return { cat, n: cn, roi: cn > 0 ? cnet / (cn * stake) : null };
  }).sort((a, b) => (b.roi ?? -99) - (a.roi ?? -99));
  $("ovCatList").innerHTML = catRows.slice(0, 5).map(c => `
    <li>
      <div><div class="ov-name">${c.cat}</div><div class="ov-meta">${c.n} pari(s)</div></div>
      <div class="ov-val ${c.roi >= 0 ? 'pos' : 'neg'}">${fmtPct(c.roi)}</div>
    </li>`).join("") || `<li class="muted">Pas encore de données.</li>`;

  const topUpcoming = UPCOMING.slice().sort((a, b) => b.ev - a.ev).slice(0, 5);
  $("ovUpcomingList").innerHTML = topUpcoming.map(v => `
    <li>
      <div><div class="ov-name">${v.match}</div><div class="ov-meta">${v.colonne} · cote ${v.cote.toFixed(2)}</div></div>
      <div class="ov-val pos">${fmtPct(v.ev)}</div>
    </li>`).join("") || `<li class="muted">Aucune piste pour l'instant — reviens après la prochaine collecte.</li>`;

  const m = WIZARD_DATA.meta;
  const chips = [
    `${m.n_odds_files} fichier(s) cotes`,
    `${m.n_results_files} fichier(s) résultats`,
    `${m.matched} match(s) rapproché(s)`,
    `${TEAM_STATS.length} équipe(s) modélisée(s)`,
    `${VALUE_BETS.length} value bet(s) au total`,
  ];
  $("ovCoverage").innerHTML = chips.map(c => `<span class="coverage-chip">${c}</span>`).join("");
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
  const cat = $("btCat") ? $("btCat").value : "";
  const ligue = $("btLigue") ? $("btLigue").value : "";
  const dedup = $("btDedup") ? $("btDedup").value === "1" : false;
  const devig = $("btDevig") ? $("btDevig").value === "1" : false;
  const enrichi = $("btEnrichi") ? $("btEnrichi").value === "avec" : false;
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
  let source = calibrer(BT_ROWS, calibActif);
  if (enrichi) {
    source = source
      .filter(r => r.p_model_xg != null)
      .map(r => ({
        ...r,
        p_model: r.p_model_xg, edge: r.edge_xg, edge_devig: r.edge_devig_xg,
        ev: r.ev_xg, lam_home: r.lam_home_xg, lam_away: r.lam_away_xg,
        // Conservées à part pour l'infobulle, qui affiche les deux lectures
        // côte à côte quel que soit le mode actif.
        p_model_buts: r.p_model, edge_buts: r.edge, edge_devig_buts: r.edge_devig,
        lam_home_buts: r.lam_home, lam_away_buts: r.lam_away,
      }));
  }

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
  const evPos = $("btEvPos") ? $("btEvPos").value === "1" : false;
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
    if (evPos) {
      const ev = alpha < 1 ? blended(r, alpha).ev : r.ev;
      if (ev == null || ev <= 0) return false;
    }
    if (dateDebut && r.date < dateDebut) return false;
    if (dateFin && r.date > dateFin) return false;
    if (cat && r.categorie !== cat) return false;
    if (ligue && r.ligue !== ligue) return false;
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
      if (mvt === "allonge" && r.raccourcit) return false;
      if (mvt === "stable" && Math.abs(v) >= 0.01) return false;
      // ÉVITER LES ALLONGEMENTS : le signal le plus solide mesuré sur les
      // données réelles. Les cotes qui s'allongent affichent un ROI très
      // dégradé (le marché s'éloigne de ce que croit le modèle), alors que
      // celles qui raccourcissent ou restent figées s'en sortent bien mieux.
      // Ce filtre est bien plus utile que « suivre les raccourcissements » :
      // il porte sur beaucoup plus de paris.
      if (mvt === "sauf_allonge" && v < -0.0001) return false;
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
    const modeEnrichi = $("btEnrichi") ? $("btEnrichi").value === "avec" : false;
    if (modeEnrichi) {
      const avecXg = BT_ROWS.filter(r => r.p_model_xg != null);
      const nMatchsXg = new Set(avecXg.map(r => r.match + r.date)).size;
      enrichiNote.style.display = "";
      enrichiNote.innerHTML = `<strong>Mode enrichi actif</strong> — ${g.n || 0} pari(s) affiché(s) `
        + `après filtres, parmi ${avecXg.length} paris testés sur ${nMatchsXg} match(s) où `
        + `l'historique xG était suffisant des deux côtés (${BT_ROWS.length} paris testés au total, `
        + `modèle en buts seul compris).`;
    } else {
      enrichiNote.style.display = "none";
    }
  }

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
    $("btCatBody").innerHTML = '<tr><td colspan="6" class="muted">Pas encore de données.</td></tr>';
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

  const stake = btStake();
  const net = g.profit * stake;
  const netEl = $("btNet");
  netEl.textContent = fmtEur(net);
  netEl.className = "st-value " + (net >= 0 ? "pos" : "neg");
  $("btNetSub").textContent = `${g.n} pari(s) · ${(g.n * stake).toLocaleString("fr-FR")} € misés`;

  const roiEl = $("btRoi");
  roiEl.textContent = fmtPct(g.roi);
  roiEl.className = "st-value " + (g.roi >= 0 ? "pos" : "neg");

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
  Object.keys(cats).forEach(k => { cats[k] = btAgg(cats[k]); });
  const order = Object.keys(cats).sort((a,b) => (cats[b].roi ?? -99) - (cats[a].roi ?? -99));
  $("btCatBody").innerHTML = order.map(c => {
    const s = cats[c];
    const cnet = s.profit * btStake();
    return `<tr>
      <td data-label=""><strong>${c}</strong></td>
      <td data-label="Paris" class="num">${s.n}</td>
      <td data-label="Réussite" class="num">${(s.taux*100).toFixed(1)} %</td>
      <td data-label="Cote moy." class="num">${s.cote_moy != null ? s.cote_moy.toFixed(2) : "—"}</td>
      <td data-label="ROI" class="num ${s.roi>=0?'pos':'neg'}"><strong>${fmtPct(s.roi)}</strong></td>
      <td data-label="Net" class="num ${cnet>=0?'pos':'neg'}">${fmtEur(cnet)}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="6" class="muted">Aucune catégorie.</td></tr>';

  renderBacktestRows();
  renderOosValidation();
  renderMouvement();
  drawCalibration();
  drawParCote();
  drawShotsAnalysis();
  drawEvolution();
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
    const gain = r.profit * btStake();
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

  const maxN = Math.max(...data.map(d => d.n));
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
    const etendue = Math.max(...rois) - Math.min(...rois);
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
    return {x: i + 1, y: cum, date: r.date, match: r.match, pari: r.colonne,
            cote: r.cote, gagne: r.gagne, score: r.score_reel, profit: r.profit};
  });

  const W = 1180, H = 300, padL = 62, padR = 22, padT = 26, padB = 38;
  const ys = pts.map(p => p.y).concat([0]);
  const xMin = 1, xMax = Math.max(2, pts.length);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
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

    const gain = best.profit * btStake();
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
["btFilter","btCat","btLigue","btDedup","btDevig","btEnrichi","btAlpha","btMvt","btPred","btEvPos","btCalib","btEdge","btCoteRange","btGarantie","btDateDebut","btDateFin"].forEach(id => {
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
    body.innerHTML = `<tr><td colspan="6" class="muted">Pas encore assez de matchs par ligue ` +
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
      <td data-label="Pays">${l.pays || "—"}</td>
      <td data-label="Ligue"><strong>${l.ligue}</strong></td>
      <td data-label="Marge" class="num ${cls}"><strong>${l.marge.toFixed(1)} %</strong></td>
      <td data-label="Matchs" class="num muted">${l.n}</td>
      <td data-label="Niveau"><span class="marge-tag ${cls}">${label}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">Aucune ligue ne correspond.</td></tr>`;

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
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
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
  const depart = parseFloat($("bkDepart") ? $("bkDepart").value : 100) || 0;

  const rows = btFiltered().slice().sort((a, b) => a.date.localeCompare(b.date));
  const parJour = {};
  rows.forEach(r => { (parJour[r.date] = parJour[r.date] || []).push(r); });
  const dates = Object.keys(parJour).sort();

  let bankroll = depart, pic = 0, picJour = null;
  const pts = [{date: "Départ", y: depart}];
  const lignes = dates.map(date => {
    const paris = parJour[date];
    const n = paris.length;
    // Mise fixe : chaque pari coûte le même montant, l'exposition du jour
    // grandit avec le nombre de paris qualifiés ce jour-là (c'est
    // justement ce qui a atteint 115€ un jour sur 5€/pari dans l'exemple
    // qui a motivé cette page). % de la bankroll : l'exposition du jour
    // est PLAFONNÉE d'avance, répartie également entre les paris du jour
    // — elle ne dépend plus du hasard du nombre de matchs qualifiés.
    const miseParPari = strategie === "pct" ? (bankroll * pctMax) / n : montantFixe;
    const exposition = miseParPari * n;
    const resultatJour = paris.reduce((s, r) => s + r.profit * miseParPari, 0);
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
    const pct = $("simStrategie").value === "pct";
    $("simFixeWrap").style.display = pct ? "none" : "";
    $("simPctWrap").style.display = pct ? "" : "none";
    renderExposition();
  });
  ["simMontantFixe", "simPct"].forEach(id => {
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

  let rows = equipes.filter(e =>
    (!ligue || e.ligue === ligue) &&
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
      <td><span class="pill">${e.ligue || "—"}</span></td>
      ${tirsCell(e.attaque, false)}
      ${tirsCell(e.defense, true)}
      <td class="num muted">${e.n}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Aucune équipe ne correspond à ces filtres.</td></tr>`;
  $("tirsRowInfo").textContent = `${rows.length} équipe(s)` + (rows.length > 500 ? " (500 affichées)" : "");
  $("tirsCount").textContent = `— ${equipes.length} équipe(s) au total`;
}

(function initTirsFilters() {
  const c = WIZARD_DATA.shots_coverage || {};
  const ligues = [...new Set((c.equipes || []).map(e => e.ligue).filter(Boolean))].sort();
  const sel = $("tiLigue");
  ligues.forEach(l => { const o = document.createElement("option"); o.value = l; o.textContent = l; sel.appendChild(o); });
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
