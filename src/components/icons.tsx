// Icon shapes from Lucide (ISC licence, public/icons/lucide-LICENSE.txt), copied here so that drawing
// these icons does not need a dependency on the whole set. Add a shape from lucide.dev when one is missing.
import { createElement, type SVGProps } from 'react';

type Shape = [tag: string, attributes: Record<string, string>][];
export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

function icon(shape: Shape) {
  return function Icon({ size = 24, strokeWidth = 2, ...rest }: IconProps) {
    const labelled = Object.keys(rest).some(name => name.startsWith('aria-') || name === 'role' || name === 'title');
    return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={labelled ? undefined : true} {...rest}>
      {shape.map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
    </svg>;
  };
}

export const ArrowUp = icon([['path',{d:'m5 12 7-7 7 7'}],['path',{d:'M12 19V5'}]]);
export const Check = icon([['path',{d:'M20 6 9 17l-5-5'}]]);
export const ChevronDown = icon([['path',{d:'m6 9 6 6 6-6'}]]);
export const ChevronRight = icon([['path',{d:'m9 18 6-6-6-6'}]]);
export const ChevronUp = icon([['path',{d:'m18 15-6-6-6 6'}]]);
export const Circle = icon([['circle',{cx:'12',cy:'12',r:'10'}]]);
export const CircleHelp = icon([['circle',{cx:'12',cy:'12',r:'10'}],['path',{d:'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'}],['path',{d:'M12 17h.01'}]]);
export const ClipboardCheck = icon([['rect',{width:'8',height:'4',x:'8',y:'2',rx:'1',ry:'1'}],['path',{d:'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'}],['path',{d:'m9 14 2 2 4-4'}]]);
export const ClipboardCopy = icon([['rect',{width:'8',height:'4',x:'8',y:'2',rx:'1',ry:'1'}],['path',{d:'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'}],['path',{d:'M16 4h2a2 2 0 0 1 2 2v4'}],['path',{d:'M21 14H11'}],['path',{d:'m15 10-4 4 4 4'}]]);
export const Columns3 = icon([['rect',{width:'18',height:'18',x:'3',y:'3',rx:'2'}],['path',{d:'M9 3v18'}],['path',{d:'M15 3v18'}]]);
export const Contrast = icon([['circle',{cx:'12',cy:'12',r:'10'}],['path',{d:'M12 18a6 6 0 0 0 0-12v12z'}]]);
export const Copy = icon([['rect',{width:'14',height:'14',x:'8',y:'8',rx:'2',ry:'2'}],['path',{d:'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'}]]);
export const Crosshair = icon([['circle',{cx:'12',cy:'12',r:'10'}],['line',{'x1':'22','x2':'18','y1':'12','y2':'12'}],['line',{'x1':'6','x2':'2','y1':'12','y2':'12'}],['line',{'x1':'12','x2':'12','y1':'6','y2':'2'}],['line',{'x1':'12','x2':'12','y1':'22','y2':'18'}]]);
export const Disc3 = icon([['circle',{cx:'12',cy:'12',r:'10'}],['path',{d:'M6 12c0-1.7.7-3.2 1.8-4.2'}],['circle',{cx:'12',cy:'12',r:'2'}],['path',{d:'M18 12c0 1.7-.7 3.2-1.8 4.2'}]]);
export const Download = icon([['path',{d:'M12 15V3'}],['path',{d:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'}],['path',{d:'m7 10 5 5 5-5'}]]);
export const ExternalLink = icon([['path',{d:'M15 3h6v6'}],['path',{d:'M10 14 21 3'}],['path',{d:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'}]]);
export const Eye = icon([['path',{d:'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'}],['circle',{cx:'12',cy:'12',r:'3'}]]);
export const EyeOff = icon([['path',{d:'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'}],['path',{d:'M14.084 14.158a3 3 0 0 1-4.242-4.242'}],['path',{d:'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'}],['path',{d:'m2 2 20 20'}]]);
export const FileArchive = icon([['path',{d:'M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5'}],['path',{d:'M14 2v5a1 1 0 0 0 1 1h5'}],['path',{d:'M8 12v-1'}],['path',{d:'M8 18v-2'}],['path',{d:'M8 7V6'}],['circle',{cx:'8',cy:'20',r:'2'}]]);
export const Files = icon([['path',{d:'M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8'}],['path',{d:'M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z'}],['path',{d:'M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1'}]]);
export const Film = icon([['rect',{width:'18',height:'18',x:'3',y:'3',rx:'2'}],['path',{d:'M7 3v18'}],['path',{d:'M3 7.5h4'}],['path',{d:'M3 12h18'}],['path',{d:'M3 16.5h4'}],['path',{d:'M17 3v18'}],['path',{d:'M17 7.5h4'}],['path',{d:'M17 16.5h4'}]]);
export const FlipHorizontal2 = icon([['path',{d:'m3 7 5 5-5 5V7'}],['path',{d:'m21 7-5 5 5 5V7'}],['path',{d:'M12 20v2'}],['path',{d:'M12 14v2'}],['path',{d:'M12 8v2'}],['path',{d:'M12 2v2'}]]);
export const FlipVertical2 = icon([['path',{d:'m17 3-5 5-5-5h10'}],['path',{d:'m17 21-5-5-5 5h10'}],['path',{d:'M4 12H2'}],['path',{d:'M10 12H8'}],['path',{d:'M16 12h-2'}],['path',{d:'M22 12h-2'}]]);
export const Folder = icon([['path',{d:'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'}]]);
export const FolderOpen = icon([['path',{d:'m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'}]]);
export const Globe = icon([['circle',{cx:'12',cy:'12',r:'10'}],['path',{d:'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'}],['path',{d:'M2 12h20'}]]);
export const GripVertical = icon([['circle',{cx:'9',cy:'12',r:'1'}],['circle',{cx:'9',cy:'5',r:'1'}],['circle',{cx:'9',cy:'19',r:'1'}],['circle',{cx:'15',cy:'12',r:'1'}],['circle',{cx:'15',cy:'5',r:'1'}],['circle',{cx:'15',cy:'19',r:'1'}]]);
export const HardDrive = icon([['path',{d:'M10 16h.01'}],['path',{d:'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'}],['path',{d:'M21.946 12.013H2.054'}],['path',{d:'M6 16h.01'}]]);
export const Hexagon = icon([['path',{d:'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'}]]);
export const Images = icon([['path',{d:'m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16'}],['path',{d:'M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2'}],['circle',{cx:'13',cy:'7',r:'1',fill:'currentColor'}],['rect',{x:'8',y:'2',width:'14',height:'14',rx:'2'}]]);
export const Info = icon([['circle',{cx:'12',cy:'12',r:'10'}],['path',{d:'M12 16v-4'}],['path',{d:'M12 8h.01'}]]);
export const Languages = icon([['path',{d:'m5 8 6 6'}],['path',{d:'m4 14 6-6 2-3'}],['path',{d:'M2 5h12'}],['path',{d:'M7 2h1'}],['path',{d:'m22 22-5-10-5 10'}],['path',{d:'M14 18h6'}]]);
export const Layers = icon([['path',{d:'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z'}],['path',{d:'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12'}],['path',{d:'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17'}]]);
export const Link2 = icon([['path',{d:'M9 17H7A5 5 0 0 1 7 7h2'}],['path',{d:'M15 7h2a5 5 0 1 1 0 10h-2'}],['line',{'x1':'8','x2':'16','y1':'12','y2':'12'}]]);
export const List = icon([['path',{d:'M3 5h.01'}],['path',{d:'M3 12h.01'}],['path',{d:'M3 19h.01'}],['path',{d:'M8 5h13'}],['path',{d:'M8 12h13'}],['path',{d:'M8 19h13'}]]);
export const LoaderCircle = icon([['path',{d:'M21 12a9 9 0 1 1-6.219-8.56'}]]);
export const MessageSquare = icon([['path',{d:'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'}]]);
export const Maximize2 = icon([['path',{d:'M15 3h6v6'}],['path',{d:'m21 3-7 7'}],['path',{d:'m3 21 7-7'}],['path',{d:'M9 21H3v-6'}]]);
export const Minimize2 = icon([['path',{d:'m14 10 7-7'}],['path',{d:'M20 10h-6V4'}],['path',{d:'m3 21 7-7'}],['path',{d:'M4 14h6v6'}]]);
export const Mouse = icon([['rect',{x:'5',y:'2',width:'14',height:'20',rx:'7'}],['path',{d:'M12 6v4'}]]);
export const Move = icon([['path',{d:'M12 2v20'}],['path',{d:'m15 19-3 3-3-3'}],['path',{d:'m19 9 3 3-3 3'}],['path',{d:'M2 12h20'}],['path',{d:'m5 9-3 3 3 3'}],['path',{d:'m9 5 3-3 3 3'}]]);
export const MoveUpRight = icon([['path',{d:'M13 5H19V11'}],['path',{d:'M19 5L5 19'}]]);
export const Minus = icon([['path',{d:'M5 12h14'}]]);
export const Network = icon([['rect',{x:'16',y:'16',width:'6',height:'6',rx:'1'}],['rect',{x:'2',y:'16',width:'6',height:'6',rx:'1'}],['rect',{x:'9',y:'2',width:'6',height:'6',rx:'1'}],['path',{d:'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3'}],['path',{d:'M12 12V8'}]]);
export const PanelRightClose = icon([['rect',{width:'18',height:'18',x:'3',y:'3',rx:'2'}],['path',{d:'M15 3v18'}],['path',{d:'m8 9 3 3-3 3'}]]);
export const PanelRightOpen = icon([['rect',{width:'18',height:'18',x:'3',y:'3',rx:'2'}],['path',{d:'M15 3v18'}],['path',{d:'m10 15-3-3 3-3'}]]);
export const Pause = icon([['rect',{x:'14',y:'3',width:'5',height:'18',rx:'1'}],['rect',{x:'5',y:'3',width:'5',height:'18',rx:'1'}]]);
export const Pin = icon([['path',{d:'M12 17v5'}],['path',{d:'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'}]]);
export const PinOff = icon([['path',{d:'M12 17v5'}],['path',{d:'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89'}],['path',{d:'m2 2 20 20'}],['path',{d:'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11'}]]);
export const Pipette = icon([['path',{d:'m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12'}],['path',{d:'m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z'}],['path',{d:'m2 22 .414-.414'}]]);
export const Play = icon([['path',{d:'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z'}]]);
export const Plus = icon([['path',{d:'M5 12h14'}],['path',{d:'M12 5v14'}]]);
export const Radius = icon([['path',{d:'M20.34 17.52a10 10 0 1 0-2.82 2.82'}],['circle',{cx:'19',cy:'19',r:'2'}],['path',{d:'m13.41 13.41 4.18 4.18'}],['circle',{cx:'12',cy:'12',r:'2'}]]);
export const Redo2 = icon([['path',{d:'m15 14 5-5-5-5'}],['path',{d:'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13'}]]);
export const RefreshCw = icon([['path',{d:'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'}],['path',{d:'M21 3v5h-5'}],['path',{d:'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'}],['path',{d:'M8 16H3v5'}]]);
export const RotateCcw = icon([['path',{d:'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'}],['path',{d:'M3 3v5h5'}]]);
export const RotateCcwSquare = icon([['path',{d:'M20 9V7a2 2 0 0 0-2-2h-6'}],['path',{d:'m15 2-3 3 3 3'}],['path',{d:'M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2'}]]);
export const RotateCw = icon([['path',{d:'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'}],['path',{d:'M21 3v5h-5'}]]);
export const RotateCwSquare = icon([['path',{d:'M12 5H6a2 2 0 0 0-2 2v3'}],['path',{d:'m9 8 3-3-3-3'}],['path',{d:'M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2'}]]);
export const Printer = icon([['path',{d:'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2'}],['path',{d:'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6'}],['rect',{x:'6',y:'14',width:'12',height:'8',rx:'1'}]]);
export const Ruler = icon([['path',{d:'M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z'}],['path',{d:'m14.5 12.5 2-2'}],['path',{d:'m11.5 9.5 2-2'}],['path',{d:'m8.5 6.5 2-2'}],['path',{d:'m17.5 15.5 2-2'}]]);
export const ScanText = icon([['path',{d:'M3 7V5a2 2 0 0 1 2-2h2'}],['path',{d:'M17 3h2a2 2 0 0 1 2 2v2'}],['path',{d:'M21 17v2a2 2 0 0 1-2 2h-2'}],['path',{d:'M7 21H5a2 2 0 0 1-2-2v-2'}],['path',{d:'M7 8h8'}],['path',{d:'M7 12h10'}],['path',{d:'M7 16h6'}]]);
export const Search = icon([['path',{d:'m21 21-4.34-4.34'}],['circle',{cx:'11',cy:'11',r:'8'}]]);
export const Shapes = icon([['path',{d:'M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z'}],['rect',{x:'3',y:'14',width:'7',height:'7',rx:'1'}],['circle',{cx:'17.5',cy:'17.5',r:'3.5'}]]);
export const SlidersHorizontal = icon([['path',{d:'M10 5H3'}],['path',{d:'M12 19H3'}],['path',{d:'M14 3v4'}],['path',{d:'M16 17v4'}],['path',{d:'M21 12h-9'}],['path',{d:'M21 19h-5'}],['path',{d:'M21 5h-7'}],['path',{d:'M8 10v4'}],['path',{d:'M8 12H3'}]]);
export const Spline = icon([['circle',{cx:'19',cy:'5',r:'2'}],['circle',{cx:'5',cy:'19',r:'2'}],['path',{d:'M5 17A12 12 0 0 1 17 5'}]]);
export const Square = icon([['rect',{width:'18',height:'18',x:'3',y:'3',rx:'2'}]]);
export const Stethoscope = icon([['path',{d:'M11 2v2'}],['path',{d:'M5 2v2'}],['path',{d:'M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1'}],['path',{d:'M8 15a6 6 0 0 0 12 0v-3'}],['circle',{cx:'20',cy:'10',r:'2'}]]);
export const Tag = icon([['path',{d:'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z'}],['circle',{cx:'7.5',cy:'7.5',r:'.5',fill:'currentColor'}]]);
export const Trash2 = icon([['path',{d:'M10 11v6'}],['path',{d:'M14 11v6'}],['path',{d:'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'}],['path',{d:'M3 6h18'}],['path',{d:'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'}]]);
export const TriangleAlert = icon([['path',{d:'m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'}],['path',{d:'M12 9v4'}],['path',{d:'M12 17h.01'}]]);
export const TriangleRight = icon([['path',{d:'M22 18a2 2 0 0 1-2 2H3c-1.1 0-1.3-.6-.4-1.3L20.4 4.3c.9-.7 1.6-.4 1.6.7Z'}]]);
export const Type = icon([['path',{d:'M12 4v16'}],['path',{d:'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2'}],['path',{d:'M9 20h6'}]]);
export const Undo2 = icon([['path',{d:'M9 14 4 9l5-5'}],['path',{d:'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11'}]]);
export const Upload = icon([['path',{d:'M12 3v12'}],['path',{d:'m17 8-5-5-5 5'}],['path',{d:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'}]]);
export const Usb = icon([['circle',{cx:'10',cy:'7',r:'1'}],['circle',{cx:'4',cy:'20',r:'1'}],['path',{d:'M4.7 19.3 19 5'}],['path',{d:'m21 3-3 1 2 2Z'}],['path',{d:'M9.26 7.68 5 12l2 5'}],['path',{d:'m10 14 5 2 3.5-3.5'}],['path',{d:'m18 12 1-1 1 1-1 1Z'}]]);
export const X = icon([['path',{d:'M18 6 6 18'}],['path',{d:'m6 6 12 12'}]]);
export const ZoomIn = icon([['circle',{cx:'11',cy:'11',r:'8'}],['line',{'x1':'21','x2':'16.65','y1':'21','y2':'16.65'}],['line',{'x1':'11','x2':'11','y1':'8','y2':'14'}],['line',{'x1':'8','x2':'14','y1':'11','y2':'11'}]]);
