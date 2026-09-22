# Leaf

Leaf è un gestore di attività personale/multiutente organizzato ad albero: ogni progetto si scompone in sotto-attività, e solo i nodi "foglia" (senza ulteriori sotto-attività) sono davvero lavorabili, con uno stato calcolato automaticamente da date e dipendenze. È un'app Flask + JavaScript nativo (nessun framework, nessun build step), pensata per essere installata ed eseguita localmente.

## Indice

- [Avvio rapido](#avvio-rapido)
- [Configurazione](#configurazione)
- [Utilizzo](#utilizzo)
  - [Le poche regole principali](#le-poche-regole-principali)
  - [Le viste](#le-viste)
  - [Creare e organizzare i task](#creare-e-organizzare-i-task)
  - [Lo stato di un task aperto](#lo-stato-di-un-task-aperto)
  - [Chiudere un task](#chiudere-un-task)
  - [Dipendenze](#dipendenze)
  - [Tempo stimato e carico di lavoro](#tempo-stimato-e-carico-di-lavoro)
  - [Codice progetto](#codice-progetto)
  - [Focus](#focus)
  - [Note](#note)
  - [Checklist](#checklist)
  - [Calendario, Pianificazione e Gantt](#calendario-pianificazione-e-gantt)
  - [Delega fra utenti](#delega-fra-utenti)
  - [Notifiche](#notifiche)
  - [Tema chiaro/scuro](#tema-chiaroscuro)
- [Gestione utenti (amministrazione)](#gestione-utenti-amministrazione)
- [Backup del database](#backup-del-database)
- [Per chi sviluppa](#per-chi-sviluppa)

## Avvio rapido

**Requisiti**: Python 3 (sviluppato/testato con la 3.13) e il pacchetto `Flask` (nessun altro requisito, nessun `requirements.txt`/ambiente virtuale — si installa `pip install flask` nel Python di sistema).

```bash
pip install flask

# 1. crea il database (SOLO la primissima volta: è distruttivo, vedi sotto)
python init_db.py

# 2. crea il primo utente, come superuser
python manage_users.py create-user --username <nome> --superuser

# 3. avvia il server
python app.py
```

Apri `http://127.0.0.1:5000` ed effettua il login con l'utente appena creato.

⚠️ **`python init_db.py` è distruttivo**: cancella e ricrea da zero le tabelle `tasks`, `notes`, `users`, `task_dependencies`, `checklist_items`, `planning_blocks` — usalo solo per il primissimo avvio o su un database di test. Non va mai rieseguito su un database con dati reali.

## Configurazione

Il database SQLite di default è `tasks.db` nella cartella del progetto. Per usare un percorso diverso (es. una cartella sincronizzata OneDrive/Google Drive/Dropbox, così i dati seguono chi lavora da più computer), imposta la variabile d'ambiente `LEAF_DB_PATH` prima di avviare il server:

```powershell
$env:LEAF_DB_PATH = "C:\Users\<utente>\OneDrive\Leaf\tasks.db"
python app.py
```

La cartella di destinazione deve già esistere. La chiave usata per firmare i cookie di sessione viene generata automaticamente al primo avvio in un file `.secret_key` accanto al progetto (o al percorso indicato da `LEAF_SECRET_KEY_PATH`) — non va mai condivisa o committata: cambiarla o perderla disconnette tutti gli utenti.

## Utilizzo

### Le poche regole principali

Tutto il resto dell'app discende da queste regole:

1. **I task formano un albero.** Un progetto (nodo radice) può avere sotto-attività, che a loro volta possono averne altre, senza limite di profondità.
2. **Solo le "foglie" (nodi senza sotto-attività) sono lavorabili.** Solo una foglia ha uno stato, una data di esecuzione, una deadline, un tempo stimato. Un ramo (nodo con figli) non ha nulla di tutto ciò: le sue date e il suo tempo stimato sono sempre calcolati automaticamente dai figli.
3. **Aggiungere una sotto-attività a una foglia la trasforma in un ramo**, cancellandone stato/focus/date proprie: da quel momento in poi lavora solo attraverso i suoi figli.
4. **Lo stato di un task aperto non si sceglie mai a mano**: è sempre calcolato automaticamente da data di esecuzione, deadline e dipendenze non risolte. Si sceglie a mano solo il risultato finale quando lo si **chiude** (Completato, Interrotto o Quarantena).
5. **Un solo task alla volta può essere in "Focus"** — il task a cui si sta lavorando adesso.
6. **Un task può essere delegato a un altro utente registrato.** L'esecutore ne diventa proprietario e può costruirci sotto un proprio sottoalbero privato; chi delega (il committente) lo segue in sola lettura, con una fase di accettazione e una fase di conferma del completamento.

### Le viste

Tre viste principali, nella barra in alto:

- **Albero** — la vista gerarchica completa: espandi/collassa i rami (anche tutti insieme, con "Espandi tutto"/"Collassa tutto"), trascina un nodo per spostarlo, cerca per titolo o descrizione (espande automaticamente i rami con un risultato dentro), apri le Note di ciascun nodo nel pannello laterale.
- **Foglie** — una tabella piatta di tutte le foglie (mai i rami), ordinabile per colonna e filtrabile per progetto e per stato con i pulsanti rapidi in alto: **FOCUS** (solo il task in focus), **OPERATIVE** (Attivo, In ritardo, Bloccato, Dipendente), **PROGRAMMATE** (Pianificato, Dipendente, Delegato), **APERTE** (tutti gli stati non chiusi), **DA VALUTARE** (Quarantena), **TUTTE**.
- **Carico di lavoro** — per ogni utente registrato, l'elenco dei task delegati a lui (o dei propri progetti con codice) con il carico di lavoro odierno aggregato — utile prima di assegnare un nuovo task a un collega.

### Creare e organizzare i task

- **+ Progetto** (barra degli strumenti) crea un nuovo nodo radice.
- Dal menu contestuale (tasto destro su un nodo, vista Albero) si aggiunge una sotto-attività, si apre la Configurazione, si elimina il nodo, si attiva/disattiva il Focus.
- Un nodo si trascina su un altro (vista Albero) per spostarlo altrove nell'albero.
- Una foglia guadagna una prima sotto-attività (diventando un ramo, regola 3) solo se il suo stato non è "bloccante" (Bloccato, Delegato, Completato, Interrotto) — evita di aggiungere lavoro sotto un task ormai congelato.

### Lo stato di un task aperto

Calcolato automaticamente, mai scelto a mano:

| Stato | Quando |
|---|---|
| ⏸ In lista | Nessuna data di esecuzione ancora impostata, nessuna dipendenza aperta |
| 🔗 Dipendente | Ha dipendenze non ancora risolte (in attesa che completino) |
| 📅 Pianificato | Data di esecuzione impostata ma non ancora raggiunta |
| ⬤ Attivo | Data di esecuzione raggiunta, nessuna dipendenza aperta, deadline non ancora superata |
| ⛔ Bloccato | Deadline superata con dipendenze ancora aperte |
| ⏰ In ritardo | Deadline superata (o assegnato esternamente e già scaduto) |
| 👤 Delegato | Assegnato a un nome esterno libero (campo "Esterna"), deadline non ancora superata |

Impostare una data di esecuzione richiede prima una deadline (se manca, si autocompila con la data odierna); la deadline non può precedere la data di esecuzione.

### Chiudere un task

Dal menu "Stato del task" si passa a **Chiuso**, scegliendo uno tra:

- **✔ Completato**
- **✖ Interrotto**
- **🔍 Quarantena** (da valutare)

Un task chiuso non può avere dipendenze proprie; chiuderlo come Completato o Interrotto lo rende automaticamente "risolto" per chi lo aveva come dipendenza. Si riapre in qualsiasi momento riportando "Stato del task" su Aperto.

### Dipendenze

Una foglia può dipendere da uno o più altri nodi (foglie o rami): finché almeno una dipendenza non è Completata/Interrotta, il task resta Dipendente/Bloccato/Pianificato secondo le date. Il bottone "Dipendenze" nella Configurazione apre un selettore ad albero; nelle viste Albero/Foglie un click sul bottone evidenzia in giallo i nodi da cui il task dipende.

### Tempo stimato e carico di lavoro

Ogni foglia può avere un tempo stimato (giorni + ore, convertiti internamente in giorni). Il **carico di lavoro** (%) di una foglia è quanto di quella stima "riempie" la sua finestra utile lavorativa (giorni feriali fra data di esecuzione e deadline, assumendo che mediamente il 60% di una giornata sia dedicabile a lavoro pianificato): sale sopra al 100% se la stima eccede il tempo realmente disponibile in quella finestra. Il carico di un ramo è la somma di quello delle sue foglie attive; la vista **Carico di lavoro** lo aggrega per utente.

### Codice progetto

Solo su un nodo radice, e solo per gli utenti autorizzati (vedi `grant-project-code` più sotto), è possibile assegnare un codice progetto nel formato `NNN-20AA` — unico in tutta l'applicazione, anche fra utenti diversi. Un nodo radice con codice progetto è riconoscibile a colpo d'occhio in Vista Albero dal simbolo 🎖️ accanto al titolo; in Vista Foglie i progetti si possono anche filtrare per "Con codice"/"Senza codice".

### Focus

Un solo task alla volta (per utente) può essere in Focus — attivabile dal menu contestuale o dalla Configurazione, solo su una foglia Aperta. Serve a marcare "cosa sto facendo adesso" indipendentemente da dove si trova nell'albero.

### Note

Ogni nodo (foglia o ramo) ha un proprio diario di note, una per giorno: aggiungerne una in un giorno già annotato la accoda a quella esistente invece di crearne una nuova. Le note supportano link cliccabili sia con sintassi esplicita `[testo](percorso o URL)` sia rilevando automaticamente URL e percorsi di file/rete incollati come testo semplice. Un click sul titolo di un task altrove nell'app salta alla sua posizione nella vista Albero.

### Checklist

Sulla Configurazione di una foglia, sotto al form principale, si può tenere una checklist libera di sotto-voci testuali con relativa data — comoda per elenchi rapidi che non meritano di diventare vere sotto-attività strutturate. Un bottone dedicato converte in blocco tutte le voci della checklist in vere sotto-attività (foglie), trasformando il nodo in un ramo.

### Calendario, Pianificazione e Gantt

- **📅 Calendario** (in Vista Foglie): sovrappone alla tabella una linea del tempo con le barre EX→DL di ogni foglia visibile, a granularità Settimana/Mese/Anno/Globale; le barre si trascinano per spostare le date.
- **Pianificazione**: una lavagna oraria personale a blocchi di 15 minuti, scorrelata da EX/DL, pensata per organizzare la giornata — non persistente a lungo termine (il passato viene ripulito automaticamente).
- **Vista Gantt** (menu contestuale di un ramo): il sottoalbero del nodo in un diagramma di Gantt con un grafico riassuntivo del carico di lavoro. Le frecce di dipendenza non sono mostrate tutte insieme (diventerebbero presto un groviglio illeggibile): un task con almeno una dipendenza ha una piccola freccia entrante a sinistra della barra, un task da cui dipende almeno un altro ne ha una uscente a destra; cliccando sul triangolino di una di queste frecce si mostrano o nascondono le frecce complete di quella direzione (entrante: tutte le sue dipendenze; uscente: solo i task che dipendono da lui).

### Delega fra utenti

Una foglia Aperta con deadline già impostata si può delegare (bottone "Delega" nella Configurazione) a un altro utente registrato oppure a un nome esterno libero. La delega interna segue tre fasi:

1. **Assegnazione** — l'esecutore ne diventa subito proprietario (può costruirci sotto un proprio sottoalbero privato); il committente continua a vederla, in sola lettura, e può negoziare via Note.
2. **Accettazione** — l'esecutore accetta o rifiuta la delega. Finché è in attesa, compare il simbolo 🤝 sia per l'esecutore che per il committente (anche risalendo, come indicatore, fino ai nodi antenati se l'albero è collassato).
3. **Completamento e conferma** — quando l'esecutore chiude la foglia come Completato, non si chiude subito in via definitiva: il committente deve **confermarla** (chiusura definitiva) o **rifiutarla** (il task riapre, di nuovo attivo per l'esecutore). Anche questa attesa mostra 🤝, con la stessa propagazione verso la radice. Una volta confermato, il task non è più modificabile da nessuno (nemmeno dall'esecutore) tranne che nel suo stato aperto/chiuso.

Un task delegato non è mai eliminabile dal suo esecutore: solo un utente superuser può farlo.

Finché la delega è attiva e aperta, il committente non vede la progressione interna di stato dell'esecutore (Pianificato/Dipendente/Bloccato/Attivo): la vede genericamente come 👤 Delegato, tranne quando la deadline è superata, dove diventa ⏰ In ritardo per entrambi.

### Notifiche

Il badge ⏰ (deadline superata) e, solo in Vista Foglie, ⚠️ (deadline entro 7 giorni) sono indicatori "live": riflettono semplicemente la data odierna, senza bisogno di essere confermati — spariscono da soli spostando la deadline o chiudendo il task. Sono invece notifiche temporanee, che si spengono aprendo la Configurazione del nodo (non riaprendosi finché la causa non si ripresenta davvero): la riga gialla/badge 📅 di un task appena diventato Attivo, il colore del titolo quando l'esecutore sposta la deadline di un task delegato, e il 🤝 di delega/completamento in attesa (quest'ultimo però richiede una vera decisione — accetta/rifiuta, conferma/rifiuta completamento — non basta averlo visto). Dal menu contestuale della propria radice in Vista Albero, "Resetta tutte le notifiche" spegne in blocco escalation e avvisi di delega ancora accesi.

### Tema chiaro/scuro

Dall'icona ⚙️ in alto a destra si sceglie fra tema Chiaro, Scuro o Automatico (segue le impostazioni del sistema) — preferenza salvata nel browser, non nell'account.

## Gestione utenti (amministrazione)

Non esiste ancora un'interfaccia di amministrazione: si usa `manage_users.py` da terminale.

```bash
python manage_users.py create-user --username mario [--superuser]
python manage_users.py list-users
python manage_users.py set-password --username mario
python manage_users.py grant-project-code --username mario
python manage_users.py revoke-project-code --username mario
```

Un utente **superuser** può eliminare un task delegato al posto dell'esecutore; l'autorizzazione **codici progetto** (`grant-project-code`) è ciò che permette di assegnare/modificare il codice progetto su un nodo radice.

## Backup del database

```bash
python backup_db.py
```

Crea uno snapshot coerente del database anche a server acceso (usa la Backup API di SQLite) in `backups/`, tenendo solo gli ultimi 2160 file (90 giorni a cadenza oraria se schedulato). Pensato per essere lanciato periodicamente da uno scheduler esterno (es. Utilità di pianificazione di Windows), non dal processo Flask stesso.

## Per chi sviluppa

Architettura, convenzioni del codice e regole di dominio applicate lato backend sono documentate in [`CLAUDE.md`](CLAUDE.md), scritto per chi (persona o assistente IA) deve modificare il codice.
