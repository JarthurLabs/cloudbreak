import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host:'127.0.0.1', port:5310, strictPort:true, proxy: { '/api': {target:'http://127.0.0.1:5311',changeOrigin:true}, '/gateway': {target:'http://127.0.0.1:5311',changeOrigin:true} } }, build: { chunkSizeWarningLimit: 650, rollupOptions: { output: { manualChunks: { three: ['three'], react: ['react', 'react-dom'] } } } } });
