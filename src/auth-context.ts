import {createContext} from 'react';
export type AuthState={initialized:boolean;authenticated:boolean;username?:string;csrfToken?:string;totpEnabled?:boolean};
export const AuthContext=createContext<{state:AuthState;install:(value:AuthState)=>void;refresh:()=>Promise<void>}|null>(null);
