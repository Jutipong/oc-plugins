# HANDOFF — พอร์ตปลั๊กอิน esp-buddy เข้า repo นี้ (จาก session ก่อนหน้า)

> เอกสารชั่วคราวสำหรับส่งต่องาน — ปกติลบได้หลัง commit แรก
> ความรู้ถาวรอยู่ใน `AGENTS.md` + `plugins/esp-buddy/README.md`

## สถานะ: พอร์ต + ทดสอบเสร็จแล้ว — เหลือแค่ commit/push (รอคำสั่งผู้ใช้เท่านั้น)

- `plugins/esp-buddy/` = พอร์ตจากปลั๊กอิน "avatar" v6 (repo ESP32-S3-AI) —
  เปลี่ยนเฉพาะชั้นชื่อ: id `esp-buddy`, ไฟล์ `esp-buddy-send.*`, env
  `ESP_BUDDY_*` (รับ `BUDY_*` / `AVATAR_*` เดิมเป็น fallback), log
  `esp-buddy-debug.log`; state machine เหมือนเดิมทุกบรรทัด
- ทดสอบแล้ว (2026-10-17, ก่อน rename — path ตอนนั้นยังเป็น `plugins/budy`):
  - **harness offline: 51/51 — ALL TESTS PASSED**
  - **live headless**: `opencode --standalone --prompt ...` → log แสดง
    `listening → thinking → working → speaking → happy → idle` แล้ว
    play pulses (wag/curious/happy/excited) ทุก ~10 วิ
  - **บอร์ดจริง**: รับ event ต่อเนื่องไม่มีซ้ำ; service โหลดปลั๊กอินจาก
    config path ได้ (`loading plugin ...`)
- หลัง rename (2026-10-18): harness 51/51 — ALL TESTS PASSED
  (`cd plugins/esp-buddy && bun run test`); ยังไม่ได้ทดสอบกับบอร์ดจริงซ้ำ
- config เครื่องนี้: `~/.config/opencode/opencode.jsonc` →
  `"plugins": ["github:Jutipong/oc-plugins#main::path:plugins/esp-buddy"]`
  (เครื่อง Windows ใช้ `file:///D:/code/oc-plugins/plugins/esp-buddy`) —
  ต้องแก้ path หลัง rename ขึ้น `main` แล้ว ไม่งั้นปลั๊กอินจะไม่โหลด
  และไฟล์ live เก่า (`budy.js`, `budy-send.*`, `avatar.js`, `avatar-send.*`)
  ต้องไม่มี — **ห้ามใส่กลับ** (ถ้าอยู่พร้อมกัน event จะซ้ำสองชุด)
- git: 2 commits แรก push ขึ้น `origin/main` แล้ว; rename
  `budy` → `esp-buddy` รอ commit/push ตามคำสั่งผู้ใช้

## งานที่เหลือ (ทุกอย่างรอคำสั่งผู้ใช้ชัดเจน — ดูกฎใน AGENTS.md)

1. ตรวจไฟล์ทั้งหมด → **commit rename** → **push** `origin main`
2. ฝั่ง ESP32-S3-AI (`D:\code\ESP32-S3-AI`): ลบ `opencode-plugins/` +
   แก้ `AGENTS.md`/`README.md`/`buddy/AGENTS.md` = **staged แล้ว รอคำสั่ง
   commit** จาก session นั้น (หรือที่นี่: `git -C D:\code\ESP32-S3-AI ...`)
3. (ตัวเลือก ยังไม่ทำ) LICENSE, เทมเพลต `plugins/_template`, CI, ลบ
   `~/.config/opencode/plugin-test/` ของเก่า (ย้ายเข้า repo แล้ว)

## หมายเหตุ

- กฎ commit: ห้าม commit/push เองทุกกรณี รอคำสั่งเท่านั้น
- sender เร็วใช้ `serialport` ที่ติดตั้งใน `plugins/esp-buddy/node_modules` แล้ว
  (`bun install` ไว้ให้) — ย้ายเครื่องให้รัน `bun install` ใน `plugins/esp-buddy`
- opencode.log เขียน `loading plugin ... esp-buddy` เป็นจังหวะ (reconciliation
  ของตัว OpenCode เอง — เกิดกับปลั๊กอินเดิมด้วย) ไม่ใช่การ reload จริงถี่ ๆ
- debug: `ESP_BUDDY_DEBUG=1` (หรือ `BUDY_DEBUG=1` แบบเดิม) แล้ว restart
  OpenCode → log ที่ `~/.config/opencode/plugins/esp-buddy-debug.log`
- โปรโตคอล/ฝั่งบอร์ด: ดู README ของ repo ESP32-S3-AI หัวข้อ "Buddy protocol"
