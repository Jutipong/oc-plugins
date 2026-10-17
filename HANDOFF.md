# HANDOFF — พอร์ตปลั๊กอิน budy เข้า repo นี้ (จาก session ก่อนหน้า)

> เอกสารชั่วคราวสำหรับส่งต่องาน — ปกติลบได้หลัง commit แรก
> ความรู้ถาวรอยู่ใน `AGENTS.md` + `plugins/budy/README.md`

## สถานะ: พอร์ต + ทดสอบเสร็จแล้ว — เหลือแค่ commit/push (รอคำสั่งผู้ใช้เท่านั้น)

- `plugins/budy/` = พอร์ตจากปลั๊กอิน "avatar" v6 (repo ESP32-S3-AI) — เปลี่ยน
  เฉพาะชั้นชื่อ: id `budy`, ไฟล์ `budy-send.*`, env `BUDY_*` (รับ `AVATAR_*`
  เดิมเป็น fallback), log `budy-debug.log`; state machine เหมือนเดิมทุกบรรทัด
- ทดสอบแล้ว (2026-10-17):
  - **harness offline: 51/51 — ALL TESTS PASSED** (`cd plugins/budy && bun run test`)
  - **live headless**: `opencode --standalone --prompt ...` → log แสดง
    `listening → thinking → working → speaking → happy → idle` แล้ว
    play pulses (wag/curious/happy/excited) ทุก ~10 วิ
  - **บอร์ดจริง**: รับ event ต่อเนื่องไม่มีซ้ำ; service ที่รันอยู่โหลด budy
    จาก config path แล้ว (`loading plugin ... plugins/budy` ใน opencode.log)
- เครื่องนี้ตั้งค่าแล้ว: `~/.config/opencode/opencode.jsonc` →
  `"plugins": ["file:///D:/code/oc-plugins/plugins/budy"]`
  และไฟล์ live เก่า (`avatar.js`, `avatar-send.*`) ถูกลบแล้ว —
  **ห้ามใส่กลับ** (ถ้าอยู่พร้อมกัน event จะซ้ำสองชุด)
- git: repo นี้ `git init -b main` + remote origin ตั้งแล้ว, ยังไม่ commit อะไร
  (`plugins/` ทั้งก้อนเป็น untracked), `node_modules`/lock อยู่ใน `.gitignore`
  ตามสมควร (lock ควร commit)

## งานที่เหลือ (ทุกอย่างรอคำสั่งผู้ใช้ชัดเจน — ดูกฎใน AGENTS.md)

1. ตรวจไฟล์ทั้งหมด → `git add -A` → **commit แรก** → **push**:
   `git push -u origin main` (repo GitHub สร้างว่างไว้แล้ว)
2. ฝั่ง ESP32-S3-AI (`D:\code\ESP32-S3-AI`): ลบ `opencode-plugins/` +
   แก้ `AGENTS.md`/`README.md`/`buddy/AGENTS.md` = **staged แล้ว รอคำสั่ง
   commit** จาก session นั้น (หรือที่นี่: `git -C D:\code\ESP32-S3-AI ...`)
3. (ตัวเลือก ยังไม่ทำ) LICENSE, เทมเพลต `plugins/_template`, CI, ลบ
   `~/.config/opencode/plugin-test/` ของเก่า (ย้ายเข้า repo แล้ว)

## หมายเหตุ

- กฎ commit: ห้าม commit/push เองทุกกรณี รอคำสั่งเท่านั้น
- sender เร็วใช้ `serialport` ที่ติดตั้งใน `plugins/budy/node_modules` แล้ว
  (`bun install` ไว้ให้) — ย้ายเครื่องให้รัน `bun install` ใน `plugins/budy`
- opencode.log เขียน `loading plugin ... budy` เป็นจังหวะ (reconciliation ของ
  ตัว OpenCode เอง — เกิดกับปลั๊กอินเดิมด้วย) ไม่ใช่การ reload จริงถี่ ๆ
- debug: `BUDY_DEBUG=1` แล้ว restart OpenCode → log ที่
  `~/.config/opencode/plugins/budy-debug.log`
- โปรโตคอล/ฝั่งบอร์ด: ดู README ของ repo ESP32-S3-AI หัวข้อ "Buddy protocol"
