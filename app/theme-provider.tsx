'use client';
import {ThemeProvider as Provider,useTheme} from 'next-themes';
import {Moon,Sun} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useEffect,useState,type ReactNode} from 'react';
export function ThemeProvider({children}:{children:ReactNode}){return <Provider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="stockroom-theme" disableTransitionOnChange>{children}</Provider>}
export function ThemeToggle(){const {resolvedTheme,setTheme}=useTheme();const [mounted,setMounted]=useState(false);useEffect(()=>setMounted(true),[]);const dark=mounted && resolvedTheme==='dark';return <Button variant="outline" size="icon" disabled={!mounted} aria-label={dark?'Switch to light mode':'Switch to dark mode'} title={dark?'Switch to light mode':'Switch to dark mode'} onClick={()=>setTheme(dark?'light':'dark')}>{dark?<Sun size={18}/>:<Moon size={18}/>}</Button>}
