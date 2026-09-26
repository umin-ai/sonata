'use client';
import {createContext,useContext} from 'react';
import type {Demo,Action} from '@/lib/vaults/demo';
export const DemoContext=createContext<{state:Demo;act:(a:Action)=>void;ready:boolean}|null>(null);
export function useDemo(){const value=useContext(DemoContext);if(!value)throw new Error('Demo provider is required');return value;}
export const money=(c:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(c/100);
