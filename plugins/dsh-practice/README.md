# dsh-practice

Structured vocabulary dictation for `dsh-wordbook`.

- `POST /dsh-practice/api/generate` — for each target word, write one natural English sentence that pins a single Chinese sense, plus accepted Chinese answers and a translation.
- `POST /dsh-practice/api/judge` — decide whether the learner's Chinese answer fits the word's meaning **in that sentence**; synonyms and colloquial answers count.

It only calls the configured DSH model. It never writes to a word list or to Maimemo.

Used by the **默写** tab in `dsh-wordbook`:
1. pick 5/10/15 words from today's Maimemo list or the local list;
2. each question shows an English context sentence and asks for the target word's Chinese meaning;
3. obviously matching answers pass locally; uncertain ones are sent to the judge;
4. results update the local Ebbinghaus schedule. Maimemo words stay read-only.
