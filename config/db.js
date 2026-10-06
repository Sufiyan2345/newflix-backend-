import mongoose from 'mongoose';

let connectionPromise;

const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not defined');

  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (mongoose.connection.readyState !== 2) connectionPromise = null;

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(uri)
      .then((conn) => {
        console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
        return conn;
      })
      .catch((err) => {
        connectionPromise = null;
        throw err;
      });
  }
  return connectionPromise;
};

export default connectDB;
