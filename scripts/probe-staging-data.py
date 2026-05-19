"""Read-only data probe for the 8 STAGING data/API guards (#890..#901)."""
from pathlib import Path
import paramiko, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

env = {}
for line in Path("local.env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(env["DEPLOY_HOST"], username=env["DEPLOY_USER"],
            password=env["DEPLOY_PASSWORD"], allow_agent=False, look_for_keys=False)

DB = 'postgresql://medcore:medcore_secure_2024@localhost:5433/medcore'

# Single-line SQL only (no embedded newlines).
queries = [
    ("#890 phantom NO_SHOW invoices (paid/partial)",
     'SELECT count(*)::int FROM invoices i JOIN appointments a ON a.id = i."appointmentId" WHERE a.status IN (\'NO_SHOW\',\'CANCELLED\') AND i."paymentStatus" IN (\'PAID\',\'PARTIAL\')'),
    ("#890 INV000426 status today",
     'SELECT i."invoiceNumber", i."paymentStatus", i."totalAmount"::text, a.status FROM invoices i JOIN appointments a ON a.id = i."appointmentId" WHERE i."invoiceNumber" = \'INV000426\''),
    ("#891 placeholder emails count",
     'SELECT count(*)::int FROM users WHERE email LIKE \'noemail+%@medcore.invalid\''),
    ("#892 name+DOB exact duplicates",
     'SELECT count(*)::int FROM (SELECT lower(name) FROM patients WHERE "dateOfBirth" IS NOT NULL GROUP BY lower(name), "dateOfBirth" HAVING count(*) > 1) t'),
    ("#892 name-only duplicates (any DOB)",
     'SELECT count(*)::int FROM (SELECT lower(name) FROM patients GROUP BY lower(name) HAVING count(*) > 1) t'),
    ("#896 impossible age/DOB pairs (>2y drift)",
     'SELECT count(*)::int FROM patients WHERE age IS NOT NULL AND "dateOfBirth" IS NOT NULL AND abs(age - extract(year from age("dateOfBirth"))::int) > 2'),
    ("#896 sample impossible rows",
     'SELECT "mrNumber", name, age, "dateOfBirth"::text, extract(year from age("dateOfBirth"))::int AS derived FROM patients WHERE age IS NOT NULL AND "dateOfBirth" IS NOT NULL AND abs(age - extract(year from age("dateOfBirth"))::int) > 2 LIMIT 5'),
    ("#898 prescription_items columns",
     "SELECT column_name FROM information_schema.columns WHERE table_name='prescription_items' ORDER BY ordinal_position"),
    ("#899 medicines master metadata",
     'SELECT count(*)::int, count(*) FILTER (WHERE "isNarcotic")::int, count(*) FILTER (WHERE schedule IS NOT NULL)::int, count(*) FILTER (WHERE "maxDailyDoseMg" IS NOT NULL)::int, count(*) FILTER (WHERE contraindications IS NOT NULL AND contraindications <> \'\')::int FROM medicines'),
    ("#901 float invoices count",
     'SELECT count(*)::int FROM invoices WHERE "totalAmount" != floor("totalAmount")'),
    ("#901 sample float invoice",
     'SELECT "invoiceNumber", "totalAmount"::text, "discountAmount"::text, "taxAmount"::text FROM invoices WHERE "totalAmount" != floor("totalAmount") LIMIT 3'),
    ("#893 ER table presence",
     "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%emergency%' OR table_name ILIKE '%triage%' OR table_name ILIKE '%er_visit%' ORDER BY 1"),
]

for label, sql in queries:
    print(f"\n=== {label} ===")
    cmd_str = f"psql '{DB}' -tA -c " + repr(sql)
    _, o, e = ssh.exec_command(cmd_str, timeout=30)
    out = o.read().decode("utf-8", "replace").strip()
    err = e.read().decode("utf-8", "replace").strip()
    if out: print(out)
    if err and 'ERROR' in err: print(f"[err] {err[:300]}")

ssh.close()
