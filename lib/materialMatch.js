"use strict";

function stripAccents(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function upper(s) { return stripAccents(s).toUpperCase().replace(/\s+/g, " ").trim(); }

function normMaterial(s) {
    let t = upper(s);
    t = t.replace(/FORAMLETA/g, "FORMALETA");
    t = t.replace(/FORMALETAS?/g, "TABLERO METALICO");
    t = t.replace(/TABLEROS? METALICOS?/g, "TABLERO METALICO");
    t = t.replace(/MTROS|METROS|MTRS|MTS\b/g, "M");
    t = t.replace(/CENTIMETROS|CMS\b/g, "CM");
    t = t.replace(/CHAPETAS?( CUADRADAS?)?/g, "CHAPETAS");
    t = t.replace(/CRUCETAS?( DE ANDAMIOS?)?/g, "CRUCETAS");
    t = t.replace(/MARCOS DE ANDAMIOS?/g, "MARCOS ANDAMIO");
    t = t.replace(/MARCOS DE ANDAMIO/g, "MARCOS ANDAMIO");
    t = t.replace(/CERCHAS?/g, "CERCHA");
    t = t.replace(/PARALES/g, "PARAL");
    t = t.replace(/ALINEADORES/g, "ALINEADOR");
    t = t.replace(/ANGULOS/g, "ANGULO");
    t = t.replace(/RINCONERAS/g, "RINCONERA");
    t = t.replace(/TABLONES DE MADERA|TABLON DE MADERA/g, "TABLON");
    t = t.replace(/TABLONES/g, "TABLON");
    t = t.replace(/BANDAS?/g, "BANDA");
    t = t.replace(/TABLEROS DE MADERA|TABLERO DE MADERA|TABREROS DE MADERA/g, "TABLERO MADERA");
    t = t.replace(/RUEDAS( NIVELADORAS| PARA ANDAMIOS| DE ANDAMIO)?/g, "RUEDAS ANDAMIO");
    t = t.replace(/CAJAS METALICAS|CAJA METALICA/g, "CAJA METALICA");
    t = t.replace(/SECCIONES DE ANDAMIO|SECCION DE ANDAMIO/g, "MARCOS ANDAMIO");
    t = t.replace(/CORBATAS|CRORBATAS/g, "CORBATA");
    t = t.replace(/[,]/g, ".");
    t = t.replace(/[xX×]/g, "*");
    t = t.replace(/[^A-Z0-9*. ]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
}
function dims(s) {
    const nums = String(s).match(/\d+(?:\.\d+)?/g) || [];
    return nums.map(n => {
        let x = Number(n);
        if (x > 0 && x <= 10) x = Math.round(x * 100);
        return Math.round(x);
    }).sort((a, b) => a - b);
}
function materialKey(s) {
    const n = normMaterial(s);
    const d = dims(n);
    const words = n.replace(/[0-9*.]/g, " ").split(" ").filter(w => w.length > 1);
    return words.slice(0, 4).join(" ") + (d.length ? " " + d.join("*") : "");
}
function attachKeys(art) {
    art._key = materialKey(art.nombre);
    art._norm = normMaterial(art.nombre);
    art._dims = dims(normMaterial(art.nombre)).join("*");
    return art;
}
function findArticulo(articulos, nombre) {
    const key = materialKey(nombre);
    let hit = articulos.find(a => a._key === key);
    if (hit) return hit;
    const n = normMaterial(nombre);
    hit = articulos.find(a => a._norm === n);
    if (hit) return hit;
    const d = dims(n).join("*");
    const head = n.split(" ").filter(w => !/^\d/.test(w)).slice(0, 2).join(" ");
    if (d && head) {
        hit = articulos.find(a => a._dims === d && a._norm.startsWith(head));
        if (hit) return hit;
    }
    return null;
}

module.exports = { stripAccents, upper, normMaterial, dims, materialKey, attachKeys, findArticulo };
