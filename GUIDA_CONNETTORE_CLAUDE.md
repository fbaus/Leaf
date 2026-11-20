# Interrogare Leaf con Claude Desktop

Con il connettore Leaf puoi fare a Claude domande sui tuoi task in linguaggio naturale, ad esempio *"cosa ho in scadenza questa settimana?"* o *"riassumi lo stato del progetto 034-2024"*, senza aprire Leaf.

## Cosa fa (e cosa non fa)

- **Sola lettura**: Claude può leggere i tuoi task, le note, le checklist e il carico di lavoro. **Non può creare, modificare o cancellare nulla**. Il server Leaf rifiuta qualunque scrittura fatta con questo accesso.
- **Vede solo i tuoi dati**, gli stessi che vedi tu accedendo a Leaf dal browser (i tuoi task e quelli che hai delegato). Non vede l'albero degli altri colleghi.
- **Funziona solo in rete aziendale** (o in VPN): il connettore parla direttamente con il server Leaf, che non è raggiungibile da internet.

## Cosa ti serve

1. **Claude Desktop** installato e con il tuo account attivo.
2. **Python 3.9 o successivo** sul tuo PC. Per controllare, apri PowerShell e scrivi `python --version`. Se non risponde con un numero di versione, installalo da python.org (spunta *"Add python.exe to PATH"* durante l'installazione). Non servono pacchetti aggiuntivi.
3. **Il tuo token personale**, che ti dà l'amministratore di Leaf. Assomiglia a `leaf_Ab3...` ed è **come una password**: non condividerlo e non scriverlo in chat o nelle email.
4. Il file **`leaf_mcp.py`** (te lo dà l'amministratore, oppure lo trovi nella cartella `leaf_mcp` del progetto Leaf).

## Installazione (5 minuti, una sola volta)

### 1. Copia lo script

Metti `leaf_mcp.py` in una cartella locale del tuo PC, ad esempio `C:\Leaf\leaf_mcp.py`. Il percorso non deve cambiare dopo la configurazione.

### 2. Trova il percorso di Python

In PowerShell:

```powershell
(Get-Command python).Source
```

Annota il risultato, ad esempio `C:\Users\mario\AppData\Local\Programs\Python\Python313\python.exe`. Se il percorso contiene `WindowsApps`, è il collegamento del Microsoft Store e a volte non funziona con Claude Desktop: in quel caso installa Python da python.org.

### 3. Modifica la configurazione di Claude Desktop

1. In Claude Desktop apri **Impostazioni → Sviluppatore → Modifica configurazione**. Si apre la cartella con il file `claude_desktop_config.json` (di solito in `%APPDATA%\Claude\`).
2. Apri il file con il Blocco note.
3. Aggiungi il blocco `leaf`. Se il file è vuoto o contiene solo `{}`, incolla tutto questo:

```json
{
  "mcpServers": {
    "leaf": {
      "command": "C:\\Users\\mario\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
      "args": ["C:\\Leaf\\leaf_mcp.py"],
      "env": {
        "LEAF_URL": "http://192.168.13.114:8000",
        "LEAF_TOKEN": "incolla-qui-il-tuo-token"
      }
    }
  }
}
```

Sostituisci:
- `command`: il percorso di Python del passo 2;
- `args`: il percorso dove hai messo `leaf_mcp.py`;
- `LEAF_TOKEN`: il tuo token personale.

Attenzione ai dettagli:
- Nei percorsi Windows ogni backslash va **raddoppiato** (`\\`), come nell'esempio.
- Se il file contiene già altri server sotto `"mcpServers"`, **non** incollare tutto: aggiungi solo il blocco `"leaf": { ... }` accanto agli altri, separato da una virgola.
- Se il file contiene già altre impostazioni, aggiungi `"mcpServers"` senza cancellarle.

### 4. Riavvia Claude Desktop

Chiudilo **completamente**, non solo la finestra: clic destro sull'icona nell'area di notifica (vicino all'orologio) e *Esci*, poi riaprilo.

### 5. Verifica

Apri una nuova conversazione e scrivi:

> Con quale utente sei connesso a Leaf?

Claude può chiederti il permesso di usare lo strumento Leaf: scegli *Consenti* (o *Consenti sempre*, se non vuoi essere interpellato ogni volta). Se risponde con il tuo nome utente, è tutto pronto.

## Cosa puoi chiedere

Claude sceglie da solo lo strumento giusto. Alcuni esempi:

- *"Cosa ho in scadenza nei prossimi 7 giorni?"*
- *"Quali dei miei task sono scaduti? Ordinali per urgenza."*
- *"Fammi un riepilogo del progetto 034-2024: a che punto siamo e cosa blocca?"*
- *"Cerca tutti i task che parlano di PIC32."*
- *"Cosa ho scritto nelle note del task 'Validazione IDC' nell'ultimo mese?"*
- *"Chi ha il carico di lavoro più alto in questo momento?"*
- *"Preparami una bozza di stato avanzamento da mandare al cliente per il progetto S495."*

Dietro le quinte Claude dispone di questi strumenti di lettura: `whoami`, `list_tasks`, `search_tasks`, `get_task`, `get_task_tree`, `get_notes`, `get_workload`.

Se vuoi riferirti a un task preciso, puoi citare il suo numero (`#626`): è quello che Claude mostra nelle risposte.

## Riservatezza: cose da sapere

- Quando Claude legge i tuoi task, **il contenuto (titoli, descrizioni, note) entra nella conversazione e viene elaborato da Anthropic**, come qualunque altro testo che scrivi a Claude. Usa il connettore secondo le regole aziendali sull'uso degli strumenti di intelligenza artificiale, soprattutto per progetti con informazioni di clienti o riservate.
- Le conversazioni restano nel tuo account Claude. Non incollare il token nelle chat.
- Se pensi che il tuo token sia stato visto da qualcun altro, avvisa subito l'amministratore: lo revoca e te ne emette uno nuovo.

## Se qualcosa non funziona

| Sintomo | Cosa controllare |
|---|---|
| Claude non mostra lo strumento Leaf | Hai riavviato Claude Desktop *completamente*? Il file JSON è valido (virgole e parentesi, backslash raddoppiati)? In Impostazioni → Sviluppatore il server `leaf` deve risultare *running*. |
| *"Impossibile raggiungere Leaf"* | Sei collegato alla rete aziendale o alla VPN? Prova ad aprire `http://192.168.13.114:8000` nel browser. Se non si apre nemmeno lì, il server Leaf è spento o irraggiungibile: avvisa l'amministratore. |
| *"Token non valido o revocato"* | Il token è stato copiato per intero, senza spazi? Se sì, chiedine uno nuovo all'amministratore. |
| *"Connettore non configurato"* | Mancano `LEAF_URL` o `LEAF_TOKEN` nel blocco `env` del file di configurazione. |
| Il server `leaf` risulta in errore | Controlla che `command` punti a un vero `python.exe` e che `args` punti al file `leaf_mcp.py` nel posto giusto. Il log si trova in `%APPDATA%\Claude\logs\mcp-server-leaf.log`. |
| Claude non trova un task che vedi in Leaf | Il connettore mostra gli stessi task del tuo utente. Prova con `search_tasks` ("cerca ...") e verifica di aver usato lo stesso utente. |

Se cambi PC, copia di nuovo lo script e rifai la configurazione con lo stesso token (o chiedine uno nuovo).

---

## Per l'amministratore di Leaf

Una tantum, sul PC dove gira il server Leaf:

1. **Aggiorna il database** (non distruttivo, rieseguibile): `python migrate_api_tokens.py`. Aggiunge la colonna `users.api_token_hash`.
2. **Riavvia il server Leaf** per caricare il nuovo codice di autenticazione.
3. **Emetti un token per ogni collega**:

   ```
   python manage_users.py create-token --username mario
   ```

   Il token viene mostrato una sola volta (nel database si conserva solo l'hash). Consegnalo al collega in modo riservato. Rieseguire il comando per lo stesso utente emette un nuovo token e **invalida il precedente**.
4. **Revoca un accesso**: `python manage_users.py revoke-token --username mario`.

Note:
- Il token identifica l'utente come il login, ma consente **solo richieste in lettura** (GET): qualunque tentativo di scrittura riceve `403`. Ogni collega vede solo ciò che vedrebbe accedendo da browser; un superuser con token vede comunque solo i propri dati, non la vista di supervisione.
- Leaf gira in HTTP semplice sulla LAN: il token viaggia in chiaro sulla rete interna, come già le password del login. Non esporre Leaf fuori dalla rete aziendale senza HTTPS.
- Per verificare il connettore senza Claude, dal PC del collega: `curl -H "Authorization: Bearer <token>" http://192.168.13.114:8000/me` deve rispondere con il suo utente.
