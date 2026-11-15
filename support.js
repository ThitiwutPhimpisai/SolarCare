/*
 * SolarCare static runtime — renders the prototype's .dc.html design components in any browser.
 * Each page is a .dc.html file: an <x-dc> template ({{holes}}, <sc-if>, <sc-for>, <dc-import>)
 * plus a <script type="text/x-dc"> holding `class Component extends DCLogic { renderVals() {…} }`.
 * This file is an independent, minimal implementation built on Preact (MIT).
 */
(function () {
  'use strict';
  var PREACT_URL = 'https://unpkg.com/preact@10.24.3/dist/preact.umd.js';

  // hide raw templates until rendered
  var hide = document.createElement('style');
  hide.textContent = 'x-dc{display:none!important}';
  (document.head || document.documentElement).appendChild(hide);

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (window.preact) return res();
      var s = document.createElement('script');
      s.src = src; s.onload = function () { res(); }; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  var HOLE_ONLY = /^\s*\{\{([^}]*)\}\}\s*$/;
  var HOLE = /\{\{([^}]*)\}\}/g;

  function lookup(expr, scopes) {
    var e = expr.trim();
    if (e === '') return undefined;
    if (e === 'true') return true;
    if (e === 'false') return false;
    if (e === 'null') return null;
    if (e === 'undefined') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (/^'.*'$|^".*"$/.test(e)) return e.slice(1, -1);
    var parts = e.split('.');
    var head = parts[0], val, found = false;
    for (var i = scopes.length - 1; i >= 0; i--) {
      var sc = scopes[i];
      if (sc && Object.prototype.hasOwnProperty.call(sc, head)) { val = sc[head]; found = true; break; }
    }
    if (!found) return undefined;
    for (var j = 1; j < parts.length; j++) { if (val == null) return undefined; val = val[parts[j]]; }
    return val;
  }
  function evalAttr(text, scopes) {
    if (text == null) return undefined;
    var m = HOLE_ONLY.exec(text);
    if (m) return lookup(m[1], scopes);
    if (text.indexOf('{{') < 0) return text;
    return text.replace(HOLE, function (_, ex) { var v = lookup(ex, scopes); return v == null ? '' : String(v); });
  }
  function camel(name) { return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  var defs = {};      // component name -> {nodes, Cls}
  var pending = {};   // name -> promise
  var helmetSeen = {};

  function applyHelmet(helmet) {
    if (!helmet) return;
    Array.prototype.forEach.call(helmet.children, function (el) {
      var key = el.outerHTML;
      if (helmetSeen[key]) return; helmetSeen[key] = 1;
      var tag = el.tagName.toLowerCase();
      if (tag === 'style') { var s = document.createElement('style'); s.textContent = el.textContent; document.head.appendChild(s); }
      else if (tag === 'link') { var l = document.createElement('link'); Array.prototype.forEach.call(el.attributes, function (a) { l.setAttribute(a.name, a.value); }); document.head.appendChild(l); }
      else if (tag === 'script') { var sc = document.createElement('script'); Array.prototype.forEach.call(el.attributes, function (a) { sc.setAttribute(a.name, a.value); }); sc.textContent = el.textContent; document.head.appendChild(sc); }
      else if (tag === 'meta') { var m = document.createElement('meta'); Array.prototype.forEach.call(el.attributes, function (a) { m.setAttribute(a.name, a.value); }); document.head.appendChild(m); }
    });
  }

  // table/select parsing rules would move or drop <sc-for>/<sc-if> inside them, so rename those tags before parsing
  var REN = /<(\/?)(table|thead|tbody|tfoot|tr|td|th|caption|select|option|optgroup)(?=[\s>\/])/gi;
  function parseSource(html) {
    var cut = html.indexOf('<script type="text/x-dc"');
    var head = cut > 0 ? html.slice(0, cut) : html, tail = cut > 0 ? html.slice(cut) : '';
    var i = head.indexOf('<x-dc');
    if (i >= 0) head = head.slice(0, i) + head.slice(i).replace(REN, '<$1dcx-$2');
    return new DOMParser().parseFromString(head + tail, 'text/html');
  }

  function makeDef(doc, name) {
    var x = doc.querySelector('x-dc');
    if (!x) throw new Error('no <x-dc> in ' + name);
    var helmet = x.querySelector('helmet');
    applyHelmet(helmet);
    var nodes = Array.prototype.filter.call(x.childNodes, function (n) { return !(n.nodeType === 1 && n.localName === 'helmet'); });
    var script = doc.querySelector('script[type="text/x-dc"]');
    var Cls = null;
    if (script) {
      Cls = new Function('DCLogic', 'window', 'document', script.textContent + '\n;return (typeof Component !== "undefined") ? Component : null;')(DCLogic, window, document);
    }
    if (!Cls) Cls = class extends DCLogic {};
    var def = { name: name, nodes: nodes, Cls: Cls };
    Cls.__dc = def;
    return def;
  }

  function importsOf(nodes, out) {
    nodes.forEach(function (n) {
      if (n.nodeType !== 1) return;
      if (n.localName === 'dc-import') { var nm = n.getAttribute('name'); if (nm) out[nm] = 1; }
      importsOf(Array.prototype.slice.call(n.childNodes), out);
    });
    return out;
  }

  function loadComponent(name) {
    if (defs[name]) return Promise.resolve(defs[name]);
    if (pending[name]) return pending[name];
    pending[name] = fetch(name + '.dc.html').then(function (r) {
      if (!r.ok) throw new Error('missing component ' + name);
      return r.text();
    }).then(function (html) {
      var def = makeDef(parseSource(html), name);
      defs[name] = def;
      return loadAll(importsOf(def.nodes, {})).then(function () { return def; });
    });
    return pending[name];
  }
  function loadAll(map) { return Promise.all(Object.keys(map).map(loadComponent)); }

  // ---- render ----
  var h, Fragment;
  var TEXT_INPUT = { text: 1, search: 1, email: 1, password: 1, number: 1, tel: 1, url: 1, date: 1, 'datetime-local': 1, time: 1, month: 1, week: 1, '': 1 };

  function build(nodes, scopes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var r = buildNode(nodes[i], scopes);
      if (r == null) continue;
      if (Array.isArray(r)) { for (var k = 0; k < r.length; k++) out.push(r[k]); } else out.push(r);
    }
    return out;
  }
  function kids(node) { return Array.prototype.slice.call(node.childNodes); }

  function buildNode(node, scopes) {
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      return t.indexOf('{{') < 0 ? t : evalAttr(t, scopes);
    }
    if (node.nodeType !== 1) return null;
    var tag = node.localName;
    if (tag === 'helmet') return null;
    if (tag === 'sc-if') {
      return evalAttr(node.getAttribute('value'), scopes) ? build(kids(node), scopes) : null;
    }
    if (tag === 'sc-for') {
      var list = evalAttr(node.getAttribute('list'), scopes);
      var as = node.getAttribute('as') || 'item';
      if (typeof list === 'number') { var arr = []; for (var q = 0; q < list; q++) arr.push(q); list = arr; }
      if (!Array.isArray(list)) return null;
      var res = [], ch = kids(node);
      list.forEach(function (item, idx) {
        var sc = {}; sc[as] = item; sc[as + 'Index'] = idx;
        res.push(h(Fragment, { key: idx }, build(ch, scopes.concat([sc]))));
      });
      return res;
    }
    if (tag === 'dc-import') {
      var name = node.getAttribute('name');
      var def = defs[name];
      if (!def) return null;
      var props = {};
      Array.prototype.forEach.call(node.attributes, function (a) {
        if (a.name === 'name' || a.name.indexOf('hint-') === 0) return;
        var v = evalAttr(a.value, scopes);
        props[camel(a.name)] = v;
      });
      return h(def.Cls, props);
    }
    // plain element
    if (tag.indexOf('dcx-') === 0) tag = tag.slice(4);
    var p = {};
    var type = (node.getAttribute('type') || '').toLowerCase();
    Array.prototype.forEach.call(node.attributes, function (a) {
      var n = a.name, v = evalAttr(a.value, scopes);
      if (n.indexOf('hint-') === 0) return;
      if (n.slice(0, 2) === 'on') {
        if (typeof v !== 'function') return;
        var ev = n.toLowerCase();
        if (ev === 'onchange' && (tag === 'textarea' || (tag === 'input' && TEXT_INPUT[type]))) ev = 'oninput'; // React-style onChange
        p[ev] = v;
        return;
      }
      if (n === 'class') { p['class'] = v; return; }
      p[n] = v;
    });
    return h(tag, p, build(kids(node), scopes));
  }

  var DCLogic;
  function defineBase(preact) {
    h = preact.h; Fragment = preact.Fragment;
    DCLogic = class DCLogic extends preact.Component {
      constructor(props) { super(props); if (!this.state) this.state = {}; }
      render() {
        var def = this.constructor.__dc;
        var vals = typeof this.renderVals === 'function' ? (this.renderVals() || {}) : {};
        var out = build(def.nodes, [vals]);
        return h(Fragment, null, out);
      }
    };
  }

  function boot() {
    loadScript(PREACT_URL).then(function () {
      defineBase(window.preact);
      var pageName = (location.pathname.split('/').pop() || '').replace(/\.dc\.html$/, '') || 'page';
      return fetch(location.pathname, { cache: 'no-cache' }).then(function (r) { return r.text(); }).then(function (html) {
       var def = makeDef(parseSource(html), pageName);
       defs[pageName] = def;
       return loadAll(importsOf(def.nodes, {})).then(function () {
        var root = document.createElement('div');
        root.id = 'dc-root';
        var x = document.querySelector('x-dc');
        x.parentNode.insertBefore(root, x);
        window.preact.render(h(def.Cls, {}), root);
       });
      });
    }).catch(function (e) {
      console.error(e);
      var d = document.createElement('pre');
      d.style.cssText = 'padding:16px;color:#B42318;white-space:pre-wrap;font:14px system-ui';
      d.textContent = 'โหลดหน้าไม่สำเร็จ: ' + (e && e.message ? e.message : e);
      document.body.appendChild(d);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
