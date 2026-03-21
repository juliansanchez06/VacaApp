import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAt_J0nsKI_9X69jgr_Q8R2z-KbO875nhg",
  authDomain: "vacaapp.firebaseapp.com",
  projectId: "vacaapp",
  storageBucket: "vacaapp.appspot.com",
  messagingSenderId: "1089865872169",
  appId: "1:1089865872169:web:836d34d16ef365a7563d38"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
