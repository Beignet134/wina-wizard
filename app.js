// WIZARD_DATA est défini dans donnees.js (généré par wina_wizard.py à chaque run),
// chargé AVANT ce fichier dans index.html.
const BETS = WIZARD_DATA.bets;
const UNMATCHED = WIZARD_DATA.unmatched_examples;
const VALUE_BETS = WIZARD_DATA.value_bets;
const MIN_BETS = WIZARD_DATA.config.min_bets_for_verdict;
const OOS_MIN = WIZARD_DATA.config.oos_min_test;
const UPCOMING_DAYS = WIZARD_DATA.config.upcoming_days;
const TEAM_STATS = WIZARD_DATA.team_stats;

// Peuple les éléments d'en-tête (cartes, dates...) qui étaient auparavant
// générés côté Python directement dans le HTML.
function initMeta() {
  const m = WIZARD_DATA.meta;
  $("metaGenerated").textContent = WIZARD_DATA.generated;
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
      <td><strong>${o.cat}</strong></td>
      <td class="num">${o.n}</td>
      <td class="num ${o.roi>=0?'pos':'neg'}"><strong>${fmtPct(o.roi)}</strong></td>
      <td class="num">${(o.winRate*100).toFixed(1)} %</td>
      <td class="num">${o.avgCote.toFixed(2)}</td>
      <td class="num ${o.testRoi>=0?'pos':'neg'}">${fmtPct(o.testRoi)}</td>
      <td><span class="badge" style="background:${o.verdict[1]}">${o.verdict[0]}</span></td>
    </tr>`).join("") || `<tr><td colspan="7" class="muted">Aucun pari ne correspond aux filtres.</td></tr>`;
}

function drawChart(rows, stake) {
  const wrap = $("chartWrap");
  const sorted = rows.slice().sort((a,b)=> a.date<b.date?-1:(a.date>b.date?1:0));
  if (sorted.length === 0) { wrap.innerHTML = '<p class="muted">Aucun pari à afficher avec les filtres actuels.</p>'; return; }
  let cum = 0;
  const pts = sorted.map((b,i) => { cum += betGain(b, stake); return {x:i+1, y:cum, date:b.date}; });
  const W = 1180, H = 320, padL = 64, padR = 20, padT = 20, padB = 34;
  const ys = pts.map(p=>p.y).concat([0]);
  const xMin = 1, xMax = Math.max(2, pts.length);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax-yMin)*0.1; yMin -= yPad; yMax += yPad;
  const sx = x => padL + (x-xMin)/(xMax-xMin)*(W-padL-padR);
  const sy = y => padT + (yMax-y)/(yMax-yMin)*(H-padT-padB);
  const path = pts.map((p,i)=> (i?"L":"M")+sx(p.x).toFixed(1)+" "+sy(p.y).toFixed(1)).join(" ");
  const stroke = cum >= 0 ? "var(--pos)" : "var(--neg)";
  let yticks = "";
  for (let i=0;i<=4;i++) {
    const yv = yMin + (yMax-yMin)*i/4, yy = sy(yv);
    yticks += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="var(--line)" opacity=".4"/>
      <text x="${padL-8}" y="${yy+4}" text-anchor="end" class="chart-tip" fill="var(--muted)">${Math.round(yv)} €</text>`;
  }
  const zeroY = sy(0);
  const zeroLine = (0>=yMin && 0<=yMax) ? `<line class="zeroline" x1="${padL}" y1="${zeroY}" x2="${W-padR}" y2="${zeroY}"/>` : "";
  let xticks = ""; const step = Math.max(1, Math.floor(pts.length/6));
  for (let i=0;i<pts.length;i+=step) {
    const p = pts[i];
    xticks += `<text x="${sx(p.x)}" y="${H-10}" text-anchor="middle" class="chart-tip" fill="var(--muted)">${p.date.slice(5)}</text>`;
  }
  const last = pts[pts.length-1];
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du gain cumulé">
      ${yticks}${zeroLine}
      <path class="curve" d="${path}" stroke="${stroke}"/>
      <circle cx="${sx(last.x)}" cy="${sy(last.y)}" r="4" fill="${stroke}"/>
      <text x="${sx(last.x)-6}" y="${sy(last.y)-10}" text-anchor="end" class="chart-tip">${fmtEur(last.y)}</text>
      ${xticks}
    </svg>`;
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
      <td><input type="checkbox" class="chk rowchk" data-id="${b.id}" ${selected.has(b.id)?"checked":""}></td>
      <td>${b.date}</td><td>${b.match}</td><td><span class="pill">${b.ligue}</span></td>
      <td class="tag-cat">${b.cat}</td><td>${b.col}</td>
      <td class="num">${b.cote.toFixed(2)}</td>
      <td>${b.won?'<span class="pos">Gagné</span>':'<span class="neg">Perdu</span>'}</td>
      <td class="num ${g>=0?'pos':'neg'}">${fmtEur(g)}</td>
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
      <td class="num ${v.ev>=0?'pos':'neg'}"><strong>${fmtPct(v.ev)}</strong></td>
      <td>${v.date}</td><td>${v.match}</td><td><span class="pill">${v.ligue}</span></td>
      <td>${v.colonne}</td><td class="num">${v.cote.toFixed(2)}</td>
      <td class="num">${(v.p_model*100).toFixed(1)} %</td>
      <td class="num muted">${(v.p_implied*100).toFixed(1)} %</td>
      <td class="num pos">${fmtPct(v.edge)}</td>
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
$("tabUpCount").textContent = UPCOMING.length;

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
  let rows = UPCOMING.filter(v => (!cat||v.categorie===cat) && v.edge>=edge);
  rows.sort((a,b) => {
    if (sortBy==="kickoff") return String(a.kickoff).localeCompare(String(b.kickoff));
    return b[sortBy]-a[sortBy];
  });
  const n = rows.length, mise = n*stake;
  const evTotal = rows.reduce((s,v)=>s+v.ev*stake, 0);
  const matches = new Set(rows.map(v=>v.match)).size;
  $("uNb").textContent = n;
  $("uMise").textContent = mise.toLocaleString("fr-FR") + " €";
  const evEl=$("uEv"); evEl.textContent=fmtEur(evTotal); evEl.className="v "+(evTotal>=0?"pos":"neg");
  $("uMatches").textContent = matches;

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
  grid.innerHTML = rows.map(v => `
    <div class="rec">
      <div class="rec-top">
        <div class="rec-match">${v.match}</div>
        <div class="rec-when">${fmtKickoff(v.kickoff)}</div>
      </div>
      <div class="rec-league">${v.ligue} · <span class="tag-cat">${v.categorie}</span></div>
      <div class="rec-bet">
        <span class="rec-pill">${v.colonne}</span>
        <span class="muted">à la cote</span> <strong style="font-family:var(--mono)">${v.cote.toFixed(2)}</strong>
      </div>
      <div class="rec-metrics">
        <div class="rec-metric"><div class="mk">Proba modèle</div><div class="mv">${(v.p_model*100).toFixed(0)} %</div></div>
        <div class="rec-metric"><div class="mk">Edge</div><div class="mv pos">${fmtPct(v.edge)}</div></div>
        <div class="rec-metric"><div class="mk">Espérance</div><div class="mv ${v.ev>=0?'pos':'neg'}">${fmtPct(v.ev)}</div></div>
      </div>
    </div>`).join("");
}
["uStake","uCat","uEdge","uSort"].forEach(id => {
  const el=$(id); el.addEventListener("input", renderUpcoming); el.addEventListener("change", renderUpcoming);
});

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

/* ---------- Init ---------- */
refresh();
renderValueBets();
renderUpcoming();
renderTeams();
