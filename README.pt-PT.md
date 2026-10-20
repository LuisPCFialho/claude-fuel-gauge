<p align="center">
  <img src="assets/hero.svg" alt="fuel-gauge: o Claude sabe finalmente quanto combustível lhe resta" width="100%">
</p>

[English](README.md) · **Português (PT-PT)**

<p align="center">
  <a href="https://github.com/LuisPCFialho/claude-fuel-gauge/releases/latest/download/fuel-gauge.plugin"><img alt="Download fuel-gauge.plugin for Cowork" src="https://img.shields.io/badge/Download-fuel--gauge.plugin-D9822B?style=for-the-badge"></a>
  <a href="https://github.com/LuisPCFialho/claude-fuel-gauge/releases/latest/download/fuel-gauge-pt.plugin"><img alt="Descarregar em português" src="https://img.shields.io/badge/Descarregar-PT--PT-5B8DEF?style=for-the-badge"></a>
  <a href="https://github.com/LuisPCFialho/claude-fuel-gauge/releases/latest/download/fuel-gauge-tray-windows.zip"><img alt="Ícone da barra do Windows" src="https://img.shields.io/badge/Windows-%C3%ADcone%20da%20barra-3FB950?style=for-the-badge"></a>
</p>

**Deixa de vigiar os limites à mão.** Acabou o "já vais em 80%, despacha" e as tarefas longas que morrem nos 100% a meio de uma alteração.

O `fuel-gauge` dá ao Claude noção dos próprios limites. Lê a janela de 5 horas, a janela semanal e o preenchimento do contexto a partir das respostas que a sessão já recebe. Mostra esses valores ao Claude em cada mensagem, desenha um pequeno medidor junto à caixa de texto e aplica um **bloqueio rígido aos 95%**, para o trabalho parar num ponto limpo e não a meio de uma edição.

## O que inclui

- **O Claude sabe os limites.** Cada mensagem leva uma linha curta com a % de cada janela, a hora de reset e o contexto. O Claude gere o trabalho e avisa logo à partida quando a margem é curta.
- **Medidor junto à caixa de texto** (terminal e desktop): duas mini barras com cor por nível e hora de reset. `/fuel` ou **Detalhes** abrem um painel.
- **Bloqueio rígido aos 95%:** as ferramentas (incluindo subagentes) e os pedidos novos são recusados. O Claude para, faz um resumo do que ficou feito e do que falta, e só continua quando começas a mensagem com `continuar` ou carregas em **Desbloquear 1 pedido**. O bloqueio levanta-se sozinho quando a janela é reposta.
- **Ritmo e orçamento:** `5h 18% (ritmo 6%/h, 95% às 16:20)` e `Semana 60% (~13%/dia até lá)`. O Claude sabe se uma tarefa cabe antes de a começar.
- **Custo de cada pedido:** `último pedido: 5h +2%, Semana +1%`, para o Claude (e tu) saberem quanto pesa cada tipo de tarefa.
- **Aviso de sessão cara:** quando um pedido gasta 3% ou mais da janela de 5h e o contexto passa dos 50%, o Claude sugere um chat novo ou `/compact` num ponto natural.
- **Aviso de versão nova:** uma vez por dia o plugin vê a versão no GitHub (um pedido pequeno, sem tokens) e o Claude avisa-te uma vez.
- **Avisos aos 80% e 90%**, também a meio de uma tarefa longa.
- **Medidor para o Cowork** (opcional): um artifact do claude.ai com dois mostradores que se atualizam depois de cada resposta.
- **Ícone na barra do Windows** (opcional): duas barras pequenas junto ao relógio.

Um chat novo não começa às cegas: retoma a última leitura (desta máquina ou do artifact do Cowork, que sobrevive às sessões na nuvem). As janelas cuja hora de reset já passou contam como 0%, e se a leitura tiver mais de 15 minutos o Claude sabe a idade dela, porque o uso feito sem o plugin (claude.ai, telemóvel) só aparece na resposta seguinte.

## Instalar

Num terminal do Claude Code:

```
/plugin install fuel-gauge --marketplace LuisPCFialho/claude-fuel-gauge
```

No Cowork: descarrega o [`fuel-gauge-pt.plugin`](https://github.com/LuisPCFialho/claude-fuel-gauge/releases/latest/download/fuel-gauge-pt.plugin), anexa-o a um chat do Cowork e pede ao Claude para o instalar; depois carrega em **Instalar** no cartão do plugin. Passa a carregar em todos os chats novos dessa conta.

Na app de desktop: **+** junto à caixa de texto, **Plugins**, **Add marketplace** com `LuisPCFialho/claude-fuel-gauge` e depois **Add plugin**. Escolhe `pt` na opção `language`.

## Quanto custa

- Ler os limites: 0 pedidos à API, 0 tokens.
- Linha em cada mensagem (`contextLine`): cerca de 50 tokens por mensagem; pode ser desligada.
- Barra, painel, avisos, bloqueio, artifact e ícone do Windows: 0 tokens.

## Opções

| Opção | Por omissão | Para que serve |
|---|---|---|
| `language` | `en` | `en` ou `pt` |
| `lockAt` | `95` | Limiar do bloqueio rígido (%) |
| `warnAt` | `80,90` | Limiares de aviso |
| `contextLine` | `true` | Enviar a linha de limites com cada mensagem |
| `gaugeArtifactUrl` | vazio | URL do artifact do medidor (Cowork) |
| `trayFile` | vazio | Caminho do `usage.json` para o ícone do Windows |

## Ícone na barra do Windows

Descarrega o [`fuel-gauge-tray-windows.zip`](https://github.com/LuisPCFialho/claude-fuel-gauge/releases/latest/download/fuel-gauge-tray-windows.zip), extrai e faz duplo clique em **install-tray.cmd**. Com o botão direito no ícone abres as **Definições**: barras, percentagem ou ambos, idioma (segue o Windows por defeito) e avisos, incluindo quando uma janela é reposta.

Com duas contas do Claude (trabalho e pessoal), usa um ícone e um ficheiro para cada uma, para nunca se misturarem: `-Name trabalho` e `-Name pessoal`.

## Nota

Plugin independente e não oficial, sem qualquer ligação à Anthropic. Licença [MIT](LICENSE).
