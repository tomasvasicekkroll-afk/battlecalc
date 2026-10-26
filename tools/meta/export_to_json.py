import json, re, sys
f=sys.argv[1]
raw=json.load(open(f,encoding='utf-8'))
txt=raw[0]['text'] if isinstance(raw,list) else raw
i=txt.index('JSONSTART')+9; j=txt.rindex('JSONEND')
body=txt[i:j]
# the tool may return the JS string JSON-quoted (escaped); try to parse directly, else unescape
try:
    data=json.loads(body)
except Exception:
    data=json.loads(json.loads('"'+body+'"'))
print(len(data),'factions')
for h,v in data.items():
    print(h, v['listsUsed'],'/',v['listsSeen'], len(v['groups']), 'groups')
json.dump(data,open('export3.json','w',encoding='utf-8'),ensure_ascii=False)
