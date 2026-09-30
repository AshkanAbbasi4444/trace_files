import gdb, json, re

src = open("bp.c").read()
src = re.sub(r"//[^\n]*|/\*.*?\*/", "", src, flags=re.S)  # a struct inside a comment doesn't count

out = []
for name in re.findall(r"\bstruct\s+(\w+)\s*\{", src):    # every "struct Name {" in your code, in order
    try:
        t = gdb.lookup_type("struct " + name)
    except gdb.error:
        continue
    fields, end = [], 0
    for f in t.fields():
        off = f.bitpos // 8
        if off > end:                                        # a gap gcc left before this field
            fields.append({"name": None, "type": None, "offset": end, "size": off - end})
        fields.append({"name": f.name, "type": str(f.type), "offset": off, "size": f.type.sizeof})
        end = off + f.type.sizeof
    if t.sizeof > end:                                       # a gap at the end
        fields.append({"name": None, "type": None, "offset": end, "size": t.sizeof - end})
    out.append({"name": "struct " + name, "size": t.sizeof, "fields": fields})

with open("bp.json", "w") as fh:
    json.dump(out, fh)
