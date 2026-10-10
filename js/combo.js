// Campo de texto com lista de sugestões pesquisável.
// Substitui o <datalist>, que no iPhone aparece só como sugestões acima do teclado.
import { esc } from './util.js';

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// palavras comuns que a Tabela FIPE escreve abreviadas
const ALIASES = { turbo: 'tb', automatico: 'aut', automatica: 'aut', manual: 'mec', mecanico: 'mec' };
const hasTerm = (name, t) => name.includes(t) || (ALIASES[t] !== undefined && name.includes(ALIASES[t]));

export function combo(input, { max = 60 } = {}) {
  let items = [];
  let matches = [];
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.hidden = true;
  // fora do <label>, para o toque na lista não devolver o foco ao campo
  (input.closest('label') || input).after(list);
  input.setAttribute('autocomplete', 'off');

  function render() {
    const terms = norm(input.value).split(/\s+/).filter(Boolean);
    matches = items.filter((name) => {
      const n = norm(name);
      return terms.every((t) => hasTerm(n, t));
    });
    const exact = matches.length === 1 && matches[0] === input.value;
    if (!items.length || exact || document.activeElement !== input) {
      list.hidden = true;
      return;
    }
    if (!matches.length) {
      list.innerHTML = '<li class="more">Nenhum resultado — confira a grafia ou continue digitando</li>';
      list.hidden = false;
      return;
    }
    list.innerHTML = matches.slice(0, max).map((name, i) => `<li data-i="${i}">${esc(name)}</li>`).join('')
      + (matches.length > max ? `<li class="more">+${matches.length - max} itens — continue digitando para filtrar</li>` : '');
    list.hidden = false;
  }

  // impede que o toque na lista tire o foco do campo antes do clique
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    input.value = matches[Number(li.dataset.i)];
    list.hidden = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur(); // fecha o teclado no celular
  });
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));

  return {
    setItems(names) {
      items = names;
      if (document.activeElement === input) render();
    },
  };
}
