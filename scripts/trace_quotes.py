sql_path = r'pipeline\bigquery_views.sql'
with open(sql_path, 'r', encoding='utf-8') as f:
    full_sql = f.read()

# Start from the line 130 offset (data_quality_flags CREATE)
lines = full_sql.split('\n')
start_line = 129  # 0-indexed = line 130
start_offset = sum(len(l)+1 for l in lines[:start_line])
snippet = full_sql[start_offset:]
print(f"Tracing from char {start_offset}, length={len(snippet)}")
print(f"First 60 chars: {repr(snippet[:60])}")
print()

in_string = False
prev_ch = ''
for i, ch in enumerate(snippet):
    if in_string:
        if ch == "'":
            # peek next
            next_ch = snippet[i+1] if i+1 < len(snippet) else ''
            if next_ch == "'":
                continue  # escaped quote, skip (will be handled next iteration)
            in_string = False
            # print(f"  CLOSE at {i}: context={repr(snippet[max(0,i-10):i+5])}")
    else:
        if prev_ch != "'" and ch == "'":  # not a '' sequence opening
            in_string = True
            # print(f"  OPEN at {i}: context={repr(snippet[max(0,i-5):i+15])}")
        elif ch == ';':
            print(f"BARE ; at offset {i}: {repr(snippet[max(0,i-30):i+30])}")
            print(f"in_string={in_string}")
    prev_ch = ch

print(f"\nFinal in_string={in_string}")

# Count all single quotes
sq_count = snippet.count("'")
print(f"Total single-quotes in data_quality_flags section: {sq_count}")
print(f"Even number (balanced): {sq_count % 2 == 0}")
