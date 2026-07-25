(function () {
  document.querySelectorAll('.code-fold').forEach(function (wrapper) {
    var button = wrapper.querySelector('.code-expand');
    var code = wrapper.querySelector('code');
    var block = wrapper.querySelector('.highlighter-rouge') || wrapper.querySelector('pre');
    if (!button || !code || !block) return;

    var languageMatch = block.className.match(/language-([\w-]+)/);
    var language = languageMatch ? languageMatch[1] : 'code';
    var toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    toolbar.innerHTML = '<span class="code-language">' + language + '</span><button class="code-copy" type="button">复制</button>';
    wrapper.appendChild(toolbar);

    var lineCount = code.textContent.replace(/\n$/, '').split('\n').length;
    var gutter = document.createElement('pre');
    gutter.className = 'code-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = Array.from({ length: lineCount }, function (_, index) {
      return index + 1;
    }).join('\n');

    var viewport = document.createElement('div');
    viewport.className = 'code-viewport';
    block.parentNode.insertBefore(viewport, block);
    viewport.appendChild(gutter);
    viewport.appendChild(block);

    var copyButton = toolbar.querySelector('.code-copy');
    copyButton.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent).then(function () {
        copyButton.textContent = '已复制';
        window.setTimeout(function () { copyButton.textContent = '复制'; }, 1600);
      });
    });

    button.textContent = '展开';
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', function () {
      var expanded = wrapper.classList.toggle('is-expanded');
      button.textContent = expanded ? '收起' : '展开';
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  });

  var buttons = document.querySelectorAll('[data-filter]');
  var cards = document.querySelectorAll('[data-categories]');
  var emptyState = document.querySelector('[data-empty-state]');

  if (!buttons.length || !cards.length) return;

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var filter = button.getAttribute('data-filter');
      var visibleCount = 0;

      buttons.forEach(function (item) {
        var active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });

      cards.forEach(function (card) {
        var matches = filter === 'all' || card.getAttribute('data-categories').indexOf(filter) !== -1;
        card.hidden = !matches;
        if (matches) visibleCount += 1;
      });

      if (emptyState) emptyState.hidden = visibleCount !== 0;
    });
  });
})();
