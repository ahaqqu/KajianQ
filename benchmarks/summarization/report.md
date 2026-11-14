# Summarizer benchmark report

Generated offline from the committed samples (`benchmarks/summarization/samples/`) and run files (`benchmarks/summarization/runs/`) at 2026-11-14T05:54:05.294Z — never hand-edited. Gate floors (ADR-0042's, applied per case): overall ≥ 0.85 AND every language ≥ 0.75 (≥ 3 scored cases per language); an arm that aborts is never a pass. The gate scores only what is deterministic — format bounds and faithfulness grounding; theme quality stays the owner's call, made from the summaries printed below.

## Samples

- Seal **v1** (created 2026-11-13T23:40:28Z): **5** cases across id (5).
- Fixture `summarizer-bench-v0` (v0-draft); cases pinned at `sha256:dcc936e8451f1fbc835639ea406baa06266c035e5dfeb125e4d58d1082f06db4`.
- The seal covers the case fixture only. Each run file additionally pins the summarizer prompt-wording hash it measured (promptsSha256), so a wording change after this seal is visible per run without re-sealing the cases.
- The gate scores what is deterministic — format bounds and faithfulness grounding — and prints every summary; theme quality stays the owner's human call, made from the report's side-by-side artifacts.
- A re-seal (any byte of cases.json changed) bumps version and archives runs/ to superseded/v<n>/ — the store refuses a run whose cases hash does not match the committed seal, so staleness is loud, never silent.

## Arms

| Model                          | Run file                                                          | Scored | Accuracy | id        | Gate     | Cost             | p50 latency | Finished                 |
| ------------------------------ | ----------------------------------------------------------------- | ------ | -------- | --------- | -------- | ---------------- | ----------- | ------------------------ |
| `deepseek/deepseek-v4.1-flash` | `benchmarks/summarization/runs/deepseek-deepseek-v4-1-flash.json` | 5/5    | 100.0%   | id 100.0% | **pass** | 12556 µUSD total | 1882 ms     | 2026-11-14T00:50:09.612Z |
| `google/gemini-3.8-flash`      | `benchmarks/summarization/runs/google-gemini-3-8-flash.json`      | 5/5    | 100.0%   | id 100.0% | **pass** | 11085 µUSD total | 5342 ms     | 2026-11-14T00:49:29.530Z |
| `openai/gpt-5-nano`            | `benchmarks/summarization/runs/openai-gpt-5-nano.json`            | 5/5    | 100.0%   | id 100.0% | **pass** | 2367 µUSD total  | 7541 ms     | 2026-11-14T00:51:24.541Z |
| `z-ai/glm-5.3-flash`           | `benchmarks/summarization/runs/z-ai-glm-5-3-flash.json`           | 5/5    | 100.0%   | id 100.0% | **pass** | 299 µUSD total   | 4363 ms     | 2026-11-14T00:50:41.854Z |

Accuracy, per-language accuracy and the gate verdict are recomputed from each run's records; the run's own totals are never trusted. Cost is the sum of per-case `costMicroUsd`; p50 latency covers the records that carry one. A run that aborts keeps its partial records and names the failure — it is evidence, never a gate result.

Every arm clears the deterministic checks at this seal, so the gate did not separate them: no arm here is a quality winner, cost is the only measured difference, and the summaries below are the evidence for the owner's read.

## Summaries (the evidence for the owner's read)

### `deepseek/deepseek-v4.1-flash`

- `sm-q-01` (id) — pass: "Surah Al-Fatihah merupakan pembuka Al-Qur'an yang memuat pujian kepada Allah sebagai Tuhan semesta alam, Yang Maha Pengasih dan Penyayang, serta Penguasa hari pembalasan. Surah ini juga menegaskan ibadah dan permohonan pertolongan hanya kepada Allah, serta doa agar diberi petunjuk ke jalan yang lurus."
- `sm-q-02` (id) — pass: "Surah Al-Ma'un menegaskan bahwa mendustakan agama tampak dalam sikap menghardik anak yatim, tidak peduli pada orang miskin, serta enggan memberi pertolongan. Surah ini juga mengecam orang yang salatnya lalai dan dilakukan hanya untuk pamer, karena ibadah semacam itu tidak disertai kepedulian sosial yang tulus."
- `sm-q-03` (id) — pass: "Surah Al-Ikhlas menegaskan tauhid, yaitu kemurnian keesaan Allah yang Maha Esa dan menjadi tempat bergantung segala sesuatu. Allah tidak beranak dan tidak diperanakkan, serta tidak ada sesuatu pun yang setara dengan-Nya."
- `sm-h-01` (id) — pass: "Bab ini membahas awal turunnya wahyu kepada Nabi Muhammad SAW dan menegaskan pentingnya niat dalam setiap amal, sebagaimana hadis tentang hijrah yang bergantung pada niat pelakunya."
- `sm-h-02` (id) — pass: "Kitab al-Taharah dalam Sunan Abu Dawud membahas hukum-hukum bersuci, meliputi wudu, mandi wajib, tayammum, serta hal-hal yang berkaitan dengan najis dan kebersihan diri. Hadis-hadisnya menjadi pedoman tentang tata cara bersuci sebagai syarat sahnya ibadah."

### `google/gemini-3.8-flash`

- `sm-q-01` (id) — pass: "Surah Al-Fatihah bertemakan pujian dan pengagungan kepada Allah sebagai Tuhan semesta alam yang Maha Pengasih serta Penguasa hari pembalasan. Surah ini menegaskan ikrar tauhid untuk menyembah dan memohon pertolongan hanya kepada-Nya, sekaligus memuat doa permohonan agar senantiasa dibimbing menuju jalan yang lurus."
- `sm-q-02` (id) — pass: "Surah Al-Ma'un menegaskan ciri-ciri pendusta agama, yaitu mereka yang memperlakukan anak yatim dengan buruk dan enggan memberi makan orang miskin. Surah ini juga memberikan peringatan keras kepada orang-orang yang lalai dalam salatnya, berbuat riya, serta enggan memberikan bantuan barang berguna kepada sesama."
- `sm-q-03` (id) — pass: "Surah Al-Ikhlas menegaskan konsep tauhid murni tentang keesaan Allah yang mutlak dan kesempurnaan sifat-sifat-Nya. Surah ini menyatakan bahwa Allah adalah tempat bergantung segala makhluk, tidak beranak maupun diperanakkan, serta tidak ada satu pun yang setara dengan-Nya."
- `sm-h-01` (id) — pass: "Kitab ini membahas tentang permulaan turunnya wahyu Ilahi kepada Nabi Muhammad shallallahu 'alaihi wasallam serta bentuk dan keadaan beliau saat menerimanya. Bab ini juga diawali dengan penegasan pentingnya keikhlasan niat dalam setiap perbuatan sebagai landasan utama dalam beramal dan menuntut ilmu."
- `sm-h-02` (id) — pass: "Kitab Thaharah dalam Sunan Abu Dawud membahas berbagai hukum, tata cara, dan adab bersuci dalam Islam sebagai syarat keabsahan ibadah. Pembahasannya mencakup tata cara berwudu, tayamum, mandi wajib, adab buang hajat, pembersihan najis, serta ketentuan terkait haid dan istihadhah."

### `openai/gpt-5-nano`

- `sm-q-01` (id) — pass: "Al-Fatihah adalah surat pembuka Al-Qur’an yang memuja Allah sebagai Tuhan seluruh alam, Yang Maha Pengasih lagi Maha Penyayang, serta Penguasa Hari Pembalasan. Surat ini menegaskan bahwa manusia hanya menyembah kepada-Nya dan hanya kepada-Nya meminta pertolongan. Inti doanya adalah memohon petunjuk ke jalan yang lurus, yaitu jalan orang-orang yang diberi nikmat, bukan jalan orang-orang yang dimurkai atau sesat."
- `sm-q-02` (id) — pass: "Surah Al-Ma’un menyoroti kemunafikan iman yang terlihat pada orang yang menolak hari pembalasan, mengusir anak yatim, dan tidak mendorong pemberian bagi fakir miskin. Ayat-ayatnya juga mengutuk mereka yang shalat tetapi lalai, riya, dan menahan kebaikan-kebaikan kecil, menegaskan bahwa ibadah tanpa empati adalah kesalehan palsu."
- `sm-q-03` (id) — pass: "Surah Al-Ikhlas menegaskan tauhid murni: Allah itu Esa, Yang Maha Tunggal (As-Samad). Ia tidak lahir maupun diperanakkan, dan tidak ada yang serupa dengan-Nya."
- `sm-h-01` (id) — pass: "Bab ini menekankan bahwa amal-amal dinilai berdasarkan niatnya, dan setiap orang memperoleh balasan sesuai dengan niat yang ia tunaikan. Melalui contoh hijrah, ditunjukkan bahwa tujuan di balik perbuatanlah yang menentukan hasilnya. Dengan demikian, niat yang benar menjadi inti penilaian atas tindakan manusia."
- `sm-h-02` (id) — pass: "Bab ini membahas taharah (bersuci) sebagai persiapan ibadah, mencakup tata cara wudu, tayamum, serta syarat dan pembatal najis. Riwayat terkait menggambarkan Nabi saat wahyu turun yang tetap menjaga kekudusan meski cuaca dingin, menegaskan pentingnya kesucian lahir dan batin bagi umat Islam."

### `z-ai/glm-5.3-flash`

- `sm-q-01` (id) — pass: "Surah Al-Fatihah merupakan pembukaan Al-Qur'an yang berisi pujian dan syukur kepada Allah sebagai Tuhan semesta alam, Yang Maha Pengasih lagi Maha Penyayang, serta Pemilik hari pembalasan. Surat ini menegaskan bahwa manusia hanya menyembah dan memohon pertolongan kepada Allah semata, sekaligus menjadi doa memohon petunjuk menuju jalan yang lurus, yaitu jalan orang-orang yang diberi nikmat, bukan jalan mereka yang dimurkai ataupun yang sesat."
- `sm-q-02` (id) — pass: "Surah Al-Ma'un mengutuk orang-orang yang mendustakan agama melalui sikap mereka yang menindas anak yatim, tidak mendorong pemberian makanan kepada kaum miskin, dan menolak bantuan. Surah ini juga mengkritik orang-orang yang shalat namun lalai, hanya ingin dilihat orang (riya'), serta bakhil dalam berbuat kebaikan, menegaskan bahwa iman yang sejati harus dibuktikan dengan ketulusan ibadah dan kepedulian terhadap sesama."
- `sm-q-03` (id) — pass: "Surah Al-Ikhlas menegaskan keesaan Allah dengan menyatakan bahwa Allah adalah Yang Maha Esa, tempat bergantung segala sesuatu, tidak beranak dan tidak diperanakkan, serta tidak ada sesuatu pun yang setara dengan-Nya. Surah ini merupakan inti ajaran tauhid yang menentukan kemurnian iman kepada Allah."
- `sm-h-01` (id) — pass: "Bab ini merupakan pembuka Sahih al-Bukhari yang membahas awal turunnya wahyu kepada Nabi Muhammad ﷺ. Hadits pertama yang disampaikan Umar bin al-Khattab menegaskan prinsip fundamental bahwa setiap amal dihitung berdasarkan niatnya, sehingga hijrah seseorang bergantung pada tujuan yang dicita-citakannya, baik untuk dunia maupun untuk wanita yang akan dinikahi."
- `sm-h-02` (id) — pass: "Bab Kitab ath-Thaharah (كتاب الطهار) dalam Sunan Abu Dawud membahas ketentuan-ketentuan kesucian, seperti wudhu, mandi, dan hal-hal yang berkaitan dengannya. Bab ini dibuka dengan hadits Aisyah yang menceritakan turunnya wahyu kepada Nabi ﷺ pada hari yang sangat dingin hingga dahi baginda berkeringat, yang dipahami para ulama sebagai penekanan betapa besarnya kedudukan kesucian dan pentingnya menyempurnakan wudhu."

## Misses

- `deepseek/deepseek-v4.1-flash`: none.
- `google/gemini-3.8-flash`: none.
- `openai/gpt-5-nano`: none.
- `z-ai/glm-5.3-flash`: none.

## Selection

Gate-passing arms at this seal: `deepseek/deepseek-v4.1-flash`, `google/gemini-3.8-flash`, `openai/gpt-5-nano`, `z-ai/glm-5.3-flash`.

Adoption is a config change made by a reviewed PR; this report supplies evidence and never switches a serving row by itself.
