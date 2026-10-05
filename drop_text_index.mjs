import 'dotenv/config';
import mongoose from 'mongoose';

// One-time maintenance: drop any legacy text index on titles (they break inserts for
// non-MongoDB text languages like Urdu/Korean because of the "language" field).
const conn = await mongoose.connect(process.env.MONGO_URI);
for (const colName of ['titles']) {
  const idx = await conn.connection.db.collection(colName).indexes();
  for (const i of idx) {
    if (Object.values(i.key).includes('text')) {
      await conn.connection.db.collection(colName).dropIndex(i.name);
      console.log(`dropped text index "${i.name}" on ${colName}`);
    }
  }
}
console.log('done');
await mongoose.disconnect();